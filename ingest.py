#!/usr/bin/env python3
"""
GhostStream Admin Ingestion Script (MP4 Edition, No-Upscale)

Responsibilities:
- Analyze input video with ffprobe
- Enforce MP4 web-optimized output (+faststart) for Telegram WebView playback
- Enforce "NO-UPSCALE" with dynamic cap:
  - duration < 10 min  -> cap 720p
  - duration >= 10 min -> cap 480p
  - never increase resolution; only keep or reduce
- Generate thumbnail (no upscale)
- Encrypt metadata (title) with AES-256-GCM (zero-knowledge at rest)
- Blind-index tags with HMAC-SHA256 (atomic: one per tag token)
- Upload MP4 + thumbnail to private Cloudflare R2
- Insert records into Supabase Postgres

Usage:
  python ingest.py --file video.mp4 --title "Titolo" --tags "tag1,tag2"
  python ingest.py --file video.mp4 --title "Titolo" --tags "tag1" --skip-compress
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

from supabase import create_client
import boto3


console = Console()


def b64_to_bytes(s: str) -> bytes:
    return base64.b64decode(s.encode("utf-8"))


def bytes_to_b64(b: bytes) -> str:
    return base64.b64encode(b).decode("utf-8")


def require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n\nSTDERR:\n{proc.stderr}"
        )


def run_json(cmd: list[str]) -> dict[str, Any]:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n\nSTDERR:\n{proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Failed to parse JSON output for: {' '.join(cmd)}\n{e}") from e


@dataclass(frozen=True)
class ProbeInfo:
    duration_seconds: float
    width: int
    height: int
    video_codec: str
    audio_codec: Optional[str]
    container: str


def ffprobe(path: Path) -> ProbeInfo:
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe not found. Please install FFmpeg (ffmpeg + ffprobe).")

    # Video stream
    v = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height",
            "-of",
            "json",
            str(path),
        ]
    )
    streams = v.get("streams") or []
    if not streams:
        raise RuntimeError("No video stream found.")
    vs = streams[0]
    video_codec = str(vs.get("codec_name") or "").lower()
    width = int(vs.get("width") or 0)
    height = int(vs.get("height") or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError("Invalid video dimensions from ffprobe.")

    # Audio stream (optional)
    a = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "json",
            str(path),
        ]
    )
    audio_streams = a.get("streams") or []
    audio_codec = None
    if audio_streams:
        audio_codec = str(audio_streams[0].get("codec_name") or "").lower()

    # Container + duration
    f = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration",
            "-of",
            "json",
            str(path),
        ]
    )
    fmt = f.get("format") or {}
    container = str(fmt.get("format_name") or "").lower()
    duration = float(fmt.get("duration") or 0.0)
    if duration <= 0:
        raise RuntimeError("Invalid duration from ffprobe.")

    return ProbeInfo(
        duration_seconds=duration,
        width=width,
        height=height,
        video_codec=video_codec,
        audio_codec=audio_codec,
        container=container,
    )


def is_mp4_container(container: str) -> bool:
    # ffprobe may return "mov,mp4,m4a,3gp,3g2,mj2"
    return "mp4" in container.split(",") or "mov" in container.split(",")


def choose_cap(duration_seconds: float) -> int:
    return 720 if duration_seconds < 600 else 480


def make_scale_filter(cap: int) -> str:
    # IMPORTANT:
    # - This filter is ONLY applied when input_height > cap (downscale needed),
    #   so it can never upscale.
    # - We still use the recommended `min(cap,ih)` expression to make the intent
    #   explicit and avoid accidental upscaling if this logic is refactored later.
    #
    # Keep aspect ratio and force even width.
    return f"scale=-2:'min({cap},ih)'"


def ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found. Please install FFmpeg (ffmpeg + ffprobe).")


def render_plan_table(inp: ProbeInfo, cap: int, will_reencode: bool, skip_compress: bool) -> None:
    t = Table(title="GhostStream Ingestion Plan")
    t.add_column("Field")
    t.add_column("Value")
    t.add_row("Input duration (s)", f"{inp.duration_seconds:.2f}")
    t.add_row("Input resolution", f"{inp.width}x{inp.height}")
    t.add_row("Input codecs", f"v={inp.video_codec}, a={inp.audio_codec or 'none'}")
    t.add_row("Input container", inp.container)
    t.add_row("Policy cap (height)", f"{cap}p")
    t.add_row("--skip-compress", str(skip_compress))
    t.add_row("Will re-encode", str(will_reencode))
    console.print(t)


def encrypt_title_envelope_b64(title: str, aes_key_b64: str) -> str:
    key = b64_to_bytes(aes_key_b64)
    if len(key) != 32:
        raise RuntimeError("GS_AES_KEY_B64 must decode to 32 bytes (AES-256).")
    aesgcm = AESGCM(key)
    iv = os.urandom(12)
    ct = aesgcm.encrypt(iv, title.encode("utf-8"), None)  # includes auth tag
    env = {"v": 1, "alg": "A256GCM", "iv_b64": bytes_to_b64(iv), "ct_b64": bytes_to_b64(ct)}
    env_json = json.dumps(env, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return bytes_to_b64(env_json)


def normalize_tag(tag: str) -> str:
    return tag.strip().lower()


def compute_tag_hmac_hex(tag: str, key_b64: str) -> str:
    key = b64_to_bytes(key_b64)
    token = normalize_tag(tag)
    if not token:
        raise RuntimeError("Empty tag token after normalization.")
    return hmac.new(key, token.encode("utf-8"), hashlib.sha256).hexdigest()


def build_r2_client() -> Any:
    endpoint = require_env("R2_ENDPOINT")
    access_key = require_env("R2_ACCESS_KEY_ID")
    secret_key = require_env("R2_SECRET_ACCESS_KEY")
    # R2 commonly uses region_name="auto"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.getenv("R2_REGION", "auto"),
    )


def upload_file_r2(
    r2: Any,
    bucket: str,
    key: str,
    file_path: Path,
    content_type: str,
    dry_run: bool,
) -> None:
    if dry_run:
        console.print(f"[yellow]DRY RUN[/yellow] Upload {file_path} -> s3://{bucket}/{key} ({content_type})")
        return
    r2.upload_file(
        Filename=str(file_path),
        Bucket=bucket,
        Key=key,
        ExtraArgs={"ContentType": content_type},
    )


def main() -> int:
    load_dotenv()

    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True, help="Input video file (mp4 or raw).")
    p.add_argument("--title", required=True, help="Video title (plaintext, will be encrypted).")
    p.add_argument("--tags", required=True, help="Comma-separated tags (blind indexed, exact match).")
    p.add_argument("--skip-compress", action="store_true", help="Try to avoid re-encoding if already compliant.")
    p.add_argument("--dry-run", action="store_true", help="Do not upload or write to DB.")
    p.add_argument("--video-prefix", default="videos", help="R2 prefix for MP4 objects.")
    p.add_argument("--thumb-prefix", default="thumbs", help="R2 prefix for thumbnail objects.")
    args = p.parse_args()

    src = Path(args.file).expanduser().resolve()
    if not src.exists():
        raise RuntimeError(f"File not found: {src}")

    ensure_ffmpeg()

    inp = ffprobe(src)
    cap = choose_cap(inp.duration_seconds)

    input_is_compliant = (
        is_mp4_container(inp.container)
        and inp.video_codec == "h264"
        and (inp.audio_codec in ("aac", None))  # audio may be absent
    )
    will_reencode = (not args.skip_compress) or (not input_is_compliant)

    render_plan_table(inp, cap, will_reencode=will_reencode, skip_compress=args.skip_compress)

    # Create processed outputs in a temp dir
    with tempfile.TemporaryDirectory(prefix="ghoststream_ingest_") as td:
        work = Path(td)
        out_mp4 = work / "out.mp4"
        out_jpg = work / "thumb.jpg"

        if args.skip_compress and input_is_compliant:
            # Still enforce faststart remux (no re-encode)
            run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(src),
                    "-c",
                    "copy",
                    "-movflags",
                    "+faststart",
                    str(out_mp4),
                ]
            )
        else:
            # Re-encode to H.264/AAC, apply NO-UPSCALE cap expression, and faststart
            # IMPORTANT (No-Upscale + "no needless downscale"):
            # - If input height <= cap, we DO NOT apply any scale filter (preserve original res).
            # - If input height  > cap, we downscale to cap.
            vf = make_scale_filter(cap) if inp.height > cap else None
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]
            if vf:
                cmd += ["-vf", vf]
            if inp.audio_codec is None:
                cmd += ["-an"]
            else:
                cmd += ["-c:a", "aac", "-b:a", "128k"]
            cmd += [str(out_mp4)]
            run(cmd)

        out_info = ffprobe(out_mp4)

        # NO-UPSCALE invariant (height and width must not exceed input)
        if out_info.height > inp.height:
            raise RuntimeError(
                f"NO-UPSCALE violated: output height {out_info.height} > input height {inp.height}"
            )
        if out_info.width > inp.width:
            raise RuntimeError(
                f"NO-UPSCALE violated: output width {out_info.width} > input width {inp.width}"
            )

        # Enforce playable codecs (even on skip)
        if out_info.video_codec != "h264":
            raise RuntimeError(f"Output video codec not H.264: {out_info.video_codec}")
        if out_info.audio_codec not in ("aac", None):
            raise RuntimeError(f"Output audio codec not AAC: {out_info.audio_codec}")
        if not is_mp4_container(out_info.container):
            raise RuntimeError(f"Output container not MP4/MOV: {out_info.container}")

        # Thumbnail (no upscale)
        thumb_ts = min(max(0.5, out_info.duration_seconds * 0.1), 5.0)
        # If already small, keep original (no scale filter). If larger, downscale to 360p height.
        thumb_vf = "scale=-2:360" if out_info.height > 360 else None
        thumb_cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{thumb_ts:.2f}",
            "-i",
            str(out_mp4),
            "-vframes",
            "1",
            "-q:v",
            "4",
        ]
        if thumb_vf:
            thumb_cmd += ["-vf", thumb_vf]
        thumb_cmd += [str(out_jpg)]
        run(thumb_cmd)

        # Encrypt title + compute tag HMACs
        # Prefer shared names (used by Edge Functions) but keep GS_* aliases for convenience.
        aes_key_b64 = os.getenv("AES_KEY_B64") or require_env("GS_AES_KEY_B64")
        tag_key_b64 = os.getenv("TAG_HMAC_KEY_B64") or require_env("GS_TAG_HMAC_KEY_B64")

        title_enc = encrypt_title_envelope_b64(args.title, aes_key_b64)
        raw_tags = [t.strip() for t in args.tags.split(",")]
        tag_tokens = [t for t in (normalize_tag(x) for x in raw_tags) if t]
        if not tag_tokens:
            raise RuntimeError("No valid tags provided after normalization.")

        tag_hmacs = [compute_tag_hmac_hex(t, tag_key_b64) for t in tag_tokens]

        # Prepare keys
        obj_id = str(uuid.uuid4())
        video_key = f"{args.video_prefix.rstrip('/')}/{obj_id}.mp4"
        thumb_key = f"{args.thumb_prefix.rstrip('/')}/{obj_id}.jpg"

        # Upload to R2
        r2_bucket = require_env("R2_BUCKET")
        r2 = build_r2_client()
        upload_file_r2(r2, r2_bucket, video_key, out_mp4, "video/mp4", args.dry_run)
        upload_file_r2(r2, r2_bucket, thumb_key, out_jpg, "image/jpeg", args.dry_run)

        # Insert into Supabase
        # Accept both SUPABASE_URL and URL (Supabase dashboard doesn't allow SUPABASE_ prefix)
        supabase_url = os.getenv("SUPABASE_URL") or require_env("URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or require_env("SERVICE_ROLE_KEY")
        sb = create_client(supabase_url, supabase_key)

        video_row = {
            "title_enc": title_enc,
            "duration_seconds": int(round(out_info.duration_seconds)),
            "width": out_info.width,
            "height": out_info.height,
            "r2_bucket": r2_bucket,
            "r2_video_key": video_key,
            "r2_thumb_key": thumb_key,
            "published": True,
        }

        if args.dry_run:
            console.print("[yellow]DRY RUN[/yellow] Would insert into videos:", video_row)
            console.print("[yellow]DRY RUN[/yellow] Would insert tag tokens:", tag_tokens)
            return 0

        inserted = sb.table("videos").insert(video_row).execute()
        if not inserted.data or len(inserted.data) != 1:
            raise RuntimeError(f"Unexpected insert response: {inserted}")
        video_id = inserted.data[0]["id"]

        tag_rows = [{"video_id": video_id, "tag_hmac": h} for h in tag_hmacs]
        sb.table("video_tag_tokens").insert(tag_rows).execute()

        console.print("[green]Ingestion complete[/green]")
        console.print(f"video_id: {video_id}")
        console.print(f"r2://{r2_bucket}/{video_key}")
        console.print(f"r2://{r2_bucket}/{thumb_key}")

        summary = Table(title="Stored Metadata (At Rest)")
        summary.add_column("Field")
        summary.add_column("Value")
        summary.add_row("title_enc (base64 envelope)", title_enc[:48] + "…")
        summary.add_row("tag tokens (plaintext)", ", ".join(tag_tokens))
        summary.add_row("tag hmacs (hex)", ", ".join([h[:12] + "…" for h in tag_hmacs]))
        console.print(summary)

        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        raise


