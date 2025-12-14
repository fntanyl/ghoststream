# GhostStream (Telegram Mini App) — MP4 Edition (No‑Upscale)

GhostStream is a **Telegram Mini App (TMA)** for browsing and watching **private MP4 videos** using a “Patreon/OnlyFans style” delivery model:

- **R2 bucket is PRIVATE**
- Client receives **time-limited presigned GET URLs (TTL = 2 hours)**
- Presigned URLs are generated **only after Telegram `initData` verification**
- **Encrypted metadata at rest** (titles are stored as ciphertext, decrypted server-side only)

Read `AGENTS.md` first — it is the non‑negotiable constitution.

---

## Repository layout

- `supabase/functions/*`: Supabase Edge Functions (Deno/TypeScript)
  - `get-feed`: feed + optional exact tag filter
  - `get-video-url`: presigned URL for MP4 playback
- `schema.sql`: Postgres schema (encrypted metadata + blind-index tags + rate-limit ledger)
- `ingest.py`: admin ingestion pipeline (ffprobe/ffmpeg + NO‑UPSCALE + faststart + encrypt + upload + DB insert)
- `src/*`: React + Vite Telegram-native frontend

---

## 1) Database setup (Supabase)

1. Create a Supabase project.
2. Open SQL Editor and run:

   - `schema.sql`

Notes:
- RLS is **forced** and **denies all** for `anon`/`authenticated`. The client never queries DB directly.
- Edge Functions use the **service role** to query/insert.

---

## 2) Storage setup (Cloudflare R2)

1. Create a bucket (must be **private**).
2. Create an R2 API token / access keys.
3. Record:
   - account id
   - access key id
   - secret access key
   - bucket name

GhostStream generates presigned URLs using S3 SigV4 for R2.

---

## 3) Edge Functions (Supabase)

### 3.1 Secrets / env vars

This environment blocks writing `.env*` files; use the provided templates and copy them into Supabase secrets:

- `env.functions.example`

Required:
- **Supabase**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **Telegram**: `TELEGRAM_BOT_TOKEN` (+ optional `TELEGRAM_INITDATA_MAX_AGE_SECONDS`)
- **Crypto**: `AES_KEY_B64`, `TAG_HMAC_KEY_B64`
- **R2**: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (+ optional `R2_ENDPOINT`, `R2_REGION`)

### 3.2 Deploy

Deploy functions:

```bash
supabase functions deploy get-feed
supabase functions deploy get-video-url
```

After deploy, your functions base URL is typically:

- `https://<project-ref>.functions.supabase.co`

---

## 4) Admin ingestion (local machine)

### 4.1 Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

You must have `ffmpeg` + `ffprobe` installed.

### 4.2 Configure env

Copy `env.ingest.example` to your own `.env` file locally (don’t commit it) and fill:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AES_KEY_B64`
- `TAG_HMAC_KEY_B64`
- `R2_*` values + `R2_BUCKET`

### 4.3 Ingest a video

```bash
python ingest.py --file /path/to/video.mp4 --title "Titolo" --tags "tag1,tag2"
```

Compression policy (**NO‑UPSCALE + cap dinamico**):
- duration < 10 min: cap 720p
- duration ≥ 10 min: cap 480p
- if input height ≤ cap: keep original (no downscale)
- if input height > cap: downscale to cap

`--skip-compress` behavior:
- still enforces MP4 + faststart
- re-encodes anyway if not H.264/AAC compliant (e.g. HEVC)

---

## 5) Frontend (React + Vite)

### 5.1 Install

```bash
npm install
```

### 5.2 Configure

Because `.env*` files are blocked here, use:
- `env.frontend.example`

Locally, rename/copy it to `.env` and set:

- `VITE_FUNCTIONS_BASE_URL=https://<project-ref>.functions.supabase.co`

For local browser testing outside Telegram, you can set:
- `VITE_DEV_INIT_DATA=auth_date=...&user=...&hash=...`

### 5.3 Run

```bash
npm run dev
```

Open the Mini App **inside Telegram** for real auth; the app sends `x-telegram-init-data` to the backend on every request.

Routing note:
- The app uses a hash router (`/#/video/<id>`) to avoid server-side rewrite requirements on static hosting.

---

## 6) Security/UX behavior highlights

- **Hostile frontend**: no secrets in client code; no metadata decryption client-side.
- **initData verification**: every request includes Telegram initData; backend verifies HMAC with bot token.
- **Rate limit**: 30 req/min/user (sliding window).
- **Presigned URLs**: TTL is exactly 2 hours.
- **URL refresh**: frontend refreshes **10 minutes before expiry** and on app resume to prevent playback cutoffs.

---

## 7) Known limitations (by design)

- A determined user can download the MP4 during the 2-hour window. DRM is out of scope.
- Tag search is **exact match only** (blind indexing).


