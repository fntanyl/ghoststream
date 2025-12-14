-- GhostStream - Database Schema (PostgreSQL / Supabase)
-- Stores encrypted metadata + blind-indexed tags.
-- Media objects live in PRIVATE Cloudflare R2 and are accessed only via presigned URLs.

-- Extensions
create extension if not exists pgcrypto;

-- 1) Videos (metadata at rest is encrypted)
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  published boolean not null default true,

  -- Encrypted metadata (AES-256-GCM envelope serialized as base64 JSON string)
  -- The platform MUST NOT store plaintext titles.
  title_enc text not null,

  duration_seconds integer not null check (duration_seconds > 0),
  width integer,
  height integer,

  -- R2 object locations (bucket private)
  r2_bucket text not null,
  r2_video_key text not null unique,
  r2_thumb_key text not null unique,

  -- Optional hints for clients
  video_mime_type text not null default 'video/mp4',
  thumb_mime_type text not null default 'image/jpeg'
);

create index if not exists videos_created_at_id_idx
  on public.videos (created_at desc, id desc);

create index if not exists videos_published_created_at_idx
  on public.videos (published, created_at desc);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_videos_updated_at on public.videos;
create trigger trg_videos_updated_at
before update on public.videos
for each row execute function public.set_updated_at();

-- 2) Blind indexing for tags (atomic HMAC tokens)
-- Each video can have N tag tokens (HMAC-SHA256 hex string, 64 chars).
create table if not exists public.video_tag_tokens (
  video_id uuid not null references public.videos(id) on delete cascade,
  tag_hmac text not null,
  created_at timestamptz not null default now(),
  primary key (video_id, tag_hmac),
  constraint tag_hmac_len check (char_length(tag_hmac) = 64)
);

create index if not exists video_tag_tokens_tag_hmac_idx
  on public.video_tag_tokens (tag_hmac);

-- 3) Rate limiting ledger (sliding window)
-- We log requests per user and endpoint; Edge Functions count requests in the last 60s.
create table if not exists public.api_requests (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  tg_user_id bigint not null,
  endpoint text not null
);

create index if not exists api_requests_user_time_idx
  on public.api_requests (tg_user_id, created_at desc);

create index if not exists api_requests_endpoint_time_idx
  on public.api_requests (endpoint, created_at desc);

-- --- RLS (deny by default; access via Edge Functions using service role) ---
alter table public.videos enable row level security;
alter table public.video_tag_tokens enable row level security;
alter table public.api_requests enable row level security;

-- Force RLS even for table owners; service_role still bypasses via BYPASSRLS.
alter table public.videos force row level security;
alter table public.video_tag_tokens force row level security;
alter table public.api_requests force row level security;

-- Deny all to anon/authenticated (client never talks directly to DB).
drop policy if exists videos_deny_all on public.videos;
create policy videos_deny_all on public.videos
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists video_tag_tokens_deny_all on public.video_tag_tokens;
create policy video_tag_tokens_deny_all on public.video_tag_tokens
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists api_requests_deny_all on public.api_requests;
create policy api_requests_deny_all on public.api_requests
  for all to anon, authenticated
  using (false)
  with check (false);


