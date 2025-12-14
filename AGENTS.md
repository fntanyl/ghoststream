# AGENTS.md - GhostStream Constitution (MP4 Edition, No-Upscale)

This document is the **non‑negotiable constitution** for GhostStream.
Any contributor (human or AI) MUST comply with it. If a requirement conflicts with this constitution,
the constitution wins.

---

## 1. Project Identity

- **Name**: GhostStream
- **Type**: Telegram Mini App (TMA) for private video directory + progressive MP4 streaming
- **Philosophy**: **Trust No One** (zero‑knowledge metadata at rest; hostile client)
- **Security Model**: “Patreon/OnlyFans style” delivery
  - Storage bucket is **PRIVATE**
  - Content is accessed only via **time‑limited presigned URLs** (TTL 2 hours)
  - URLs are generated **only** for Telegram‑authenticated users
  - **Important reality**: a determined user can download during the valid window; DRM is out of scope

---

## 2. Security Prime Directives (NON‑NEGOTIABLE)

### 1) Hostile Frontend Doctrine
The frontend is **untrusted** and must be treated as hostile.

- **Never** embed secrets in client code:
  - `AES_SECRET`, `HMAC_SECRET`, `R2_SECRET_KEY`, `SERVICE_ROLE_KEY`, Bot token, etc.
- **Never** decrypt metadata on the client.
- **Never** call R2 directly without presigned URLs.

**Violations to avoid**
- Putting secrets in `.env` with a `VITE_` prefix (Vite exposes them to the browser).
- Shipping encryption keys inside JS bundles or `localStorage`.

### 2) Server‑Side Decryption Only
- **All metadata decryption** happens **only** in Supabase Edge Functions.
- The database stores **ciphertext** for sensitive fields (e.g., title).
- Frontend receives only **decrypted content needed for rendering** *after* auth + authorization.

**Violations to avoid**
- Creating “decryptTitle()” in `src/`.
- Returning ciphertext to the frontend “and letting it decrypt”.

### 3) Blind Indexing (Atomic)
Tags are stored as **atomic HMAC‑SHA256 tokens** (one HMAC per word/tag).

- Storage: `HMAC(tag_token)` where `tag_token` is normalized (lowercase, trim).
- Search supports **exact match** only.
- No partial, fuzzy, stemming, substring queries (unless re‑designed).

**Violations to avoid**
- Storing tags in plaintext arrays.
- Hashing a comma‑joined string (breaks atomicity).
- “Contains” search on ciphertext.

### 4) MP4 Web Optimized Delivery (faststart)
Media is served as single MP4 files optimized for progressive download:

- Container: **MP4**
- Video: **H.264 (libx264)**
- Audio: **AAC**
- Critical: `movflags=+faststart` (moov atom at the beginning)
- Pixel format: prefer `yuv420p` for widest WebView compatibility
- **No HLS/DASH**: keep delivery simple (one MP4 per video)

**Violations to avoid**
- Uploading H.265/HEVC MP4 and hoping it plays.
- Serving `.m3u8` or segment-based delivery.
- Skipping faststart (causes long “black screen” on mobile).

### 5) Presigned URL Access Control (TTL 2h)
All media objects (video + thumbnail) are stored in an R2 bucket that is:

- **Private** (no public access)
- Accessible **only** via presigned GET URLs
- URL TTL: **2 hours** exactly (unless changing constitution)

**Violations to avoid**
- Public bucket or “public read” objects.
- Permanent signed URLs.
- Embedding R2 credentials in the client.

### 6) Presigned URL Lifecycle (Client Refresh)
The frontend MUST refresh URLs **proactively**:

- Refresh **10 minutes before expiry** to prevent playback interruption.
- Handle:
  - backgrounding the app
  - long pauses
  - network failures (retry + user messaging)

**Violations to avoid**
- Fetching URL once and assuming it lasts forever.
- Refreshing only after a 403/expired error.

### 7) Rate Limiting (Sliding Window)
Every Edge Function endpoint MUST enforce:

- **Max 30 requests per minute per user**
- **Sliding window** semantics (not “per minute bucket”)
- Rate limit identity derives from the verified Telegram user ID

**Violations to avoid**
- Client-side only rate limiting.
- IP-based rate limiting as primary control (Telegram users can share IPs).

### 8) Telegram Anti‑Spoofing (initData Verification)
Every API request from the client must include `initData`. Backend MUST:

- Validate the initData signature via Telegram algorithm (HMAC)
- Extract user identity from verified initData
- Reject missing/invalid initData with 401

**Violations to avoid**
- Trusting `user_id` passed from client JSON.
- Skipping initData verification “in dev” and forgetting to re-enable.

### 9) Telegram‑Native UI
Frontend must feel like Telegram, not a generic web page:

- Use `@telegram-apps/telegram-ui`
- Use Telegram CSS variables
- Use Haptic feedback on meaningful interactions
- Integrate BackButton behavior via SDK

**Violations to avoid**
- Heavy custom UI kits that clash with Telegram styling.
- Ignoring safe area and WebView constraints.

### 10) Mobile‑First Media (No‑Upscale)
**No‑Upscale is non‑negotiable**: never increase resolution beyond input.

Output target:
- Video: H.264
- Audio: AAC 128 kbps
- MP4 +faststart
- Prefer `yuv420p`

Dynamic cap policy (height-based):
- If duration < 10 minutes: cap = **720p**
- If duration ≥ 10 minutes: cap = **480p**
- If input_height ≤ cap: **keep original** (no unnecessary downscale)
- If input_height > cap: **downscale** to cap
- If input_height < 480p: keep original (allowed); **never upscale**

**Violations to avoid**
- Forcing 720p output when input is 360p (“upscale”).
- Downscaling 540p to 480p “because cap=480” when duration<10m (cap is 720 then).

---

## 3. Media Delivery Model

- **Private storage**: Cloudflare R2 bucket must be private; no public access.
- **Access path**:
  - Client requests feed/video URL from Edge Function
  - Edge Function verifies Telegram initData + rate limits
  - Edge Function decrypts metadata (server-side only)
  - Edge Function issues **presigned GET** for:
    - `video.mp4`
    - `thumb.jpg`
  - Client plays MP4 via native `<video>` element (progressive download).
- **No file encryption for MP4 objects**:
  - Protection is in bucket privacy + expiring URLs
  - Metadata encryption provides “zero-knowledge at rest” for titles, etc.

---

## 4. Media Optimization Standards (No‑Upscale)

### Output Standard
- Container: MP4
- Video codec: H.264 (libx264)
- Audio codec: AAC 128k
- Pixel format: yuv420p (recommended)
- Web optimized: `-movflags +faststart`

### Dynamic Cap Logic (MUST)
Given `duration_seconds` and `input_height`:

- `cap = 720` if `duration_seconds < 600`, else `cap = 480`
- Apply scaling **only as a cap**:
  - scale height = `min(cap, input_height)`
  - never scale above input height

Recommended ffmpeg filter (keeps aspect ratio, avoids upscaling):
- Short video (<10m): `scale=-2:'min(720,ih)'`
- Long video (>=10m): `scale=-2:'min(480,ih)'`

### Why These Choices
- H.264/AAC + yuv420p maximize compatibility in Telegram WebViews.
- faststart enables immediate playback without full file download.
- Dynamic cap reduces bandwidth/storage while respecting no-upscale and avoiding “needless downscale”.

---

## 5. UX/UI Guidelines (Telegram‑Native)

- Use Telegram UI components (`@telegram-apps/telegram-ui`) for:
  - lists, cards, buttons, search field, skeleton/loading states
- Respect Telegram theme variables; do not hardcode colors.
- Implement:
  - **BackButton** support (navigate list ↔ player)
  - **HapticFeedback** for primary taps (play/open, filter apply)
  - Empty states and offline messaging
- Mobile-first:
  - Avoid heavy layouts; keep everything scroll-friendly
  - Ensure tappable targets are large enough

---

## 6. Forbidden Patterns (Hard NO)

- Any **upscale** (explicit or implicit) in ffmpeg filters.
- Trusting client-provided `user_id`, `is_admin`, etc.
- Any secret in frontend code or exposed env.
- Serving media from a public bucket.
- Returning presigned URLs without verifying `initData`.
- “skip-compress” that skips validation:
  - If not MP4/H.264/AAC, it MUST re-encode even with `--skip-compress`.

### Examples of Code That Must Never Exist

**Frontend secret usage (FORBIDDEN):**
```ts
// ❌ Never do this:
const R2_SECRET_KEY = import.meta.env.VITE_R2_SECRET_KEY;
```

**Client-side decryption (FORBIDDEN):**
```ts
// ❌ Never do this:
decryptTitle(ciphertext, import.meta.env.VITE_AES_KEY);
```

**Upscale (FORBIDDEN):**
```bash
# ❌ Never do this: forces height to 720 even if input is 360p
ffmpeg -i in.mp4 -vf "scale=-2:720" out.mp4
```

---

## 7. Pre‑Commit Checklist

- [ ] No secrets in frontend (`VITE_*` only contains public values)
- [ ] All Edge Functions verify Telegram `initData` signature
- [ ] All Edge Functions apply rate limiting (30 req/min/user, sliding window)
- [ ] DB stores encrypted metadata; no plaintext titles at rest
- [ ] Tags stored as atomic HMAC tokens; search is exact match only
- [ ] R2 bucket private; media served only via presigned URLs (TTL 2h)
- [ ] Frontend refreshes presigned URLs 10 minutes before expiry
- [ ] MP4 outputs are web optimized (`+faststart`)
- [ ] NO‑UPSCALE verified: output never exceeds input resolution
- [ ] Dynamic cap logic verified (720p short, 480p long) with “no needless downscale”

