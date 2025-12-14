/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { requireEnv } from "../_shared/env.ts";
import { aesGcmDecryptEnvelopeB64, hmacSha256Hex, normalizeTagToken } from "../_shared/crypto.ts";
import { extractInitDataFromRequest, verifyTelegramInitData } from "../_shared/telegram.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { presignR2GetObject, requireAesKeyB64, requireTagHmacKeyBytes } from "../_shared/r2.ts";
import type { VideoRow } from "../_shared/types.ts";

type FeedRequest = {
  limit?: number;
  cursorCreatedAt?: string;
  cursorId?: string;
  tag?: string;
};

function parseLimit(n: unknown): number {
  const x = typeof n === "string" ? Number(n) : typeof n === "number" ? n : NaN;
  if (!Number.isFinite(x)) return 20;
  return Math.min(50, Math.max(1, Math.floor(x)));
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const headers: HeadersInit = {
    ...corsHeaders,
    "Cache-Control": "no-store",
  };

  try {
    const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
    const initDataMaxAgeSeconds = Number(Deno.env.get("TELEGRAM_INITDATA_MAX_AGE_SECONDS") ?? "86400");

    const initData = extractInitDataFromRequest(req);
    if (!initData) return errorResponse(401, "Missing Telegram initData", undefined, headers);

    const verified = await verifyTelegramInitData(initData, botToken, initDataMaxAgeSeconds);
    const tgUserId = verified.user.id;

    const supabase = createSupabaseAdminClient();

    const rl = await enforceRateLimit({
      supabase,
      tgUserId,
      endpoint: "get-feed",
      limitPerMinute: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) {
      return jsonResponse(
        429,
        { ok: false, error: { message: "Rate limit exceeded" }, rateLimit: rl },
        {
          ...headers,
          "Retry-After": String(rl.retryAfterSeconds),
        },
      );
    }

    const url = new URL(req.url);
    const body = req.method === "POST" ? await readJson<FeedRequest>(req) : null;

    const limit = parseLimit(body?.limit ?? url.searchParams.get("limit"));
    const cursorCreatedAt = (body?.cursorCreatedAt ?? url.searchParams.get("cursorCreatedAt")) || undefined;
    const cursorId = (body?.cursorId ?? url.searchParams.get("cursorId")) || undefined;
    const tagRaw = (body?.tag ?? url.searchParams.get("tag")) || undefined;

    const aesKeyB64 = requireAesKeyB64();

    const baseSelect =
      "id,created_at,title_enc,duration_seconds,width,height,r2_bucket,r2_thumb_key,published";

    let query = supabase.from("videos").select(baseSelect).eq("published", true);

    if (tagRaw) {
      const token = normalizeTagToken(tagRaw);
      if (!token) return errorResponse(400, "Invalid tag", undefined, headers);

      const tagKey = requireTagHmacKeyBytes();
      const tagHmac = await hmacSha256Hex(tagKey, token);

      // Inner join: keep only videos matching token.
      query = supabase
        .from("videos")
        .select(
          `${baseSelect},video_tag_tokens!inner(tag_hmac)`,
        )
        .eq("published", true)
        .eq("video_tag_tokens.tag_hmac", tagHmac);
    }

    // Keyset pagination: (created_at, id) desc
    if (cursorCreatedAt && cursorId) {
      // where created_at < cursorCreatedAt OR (created_at = cursorCreatedAt AND id < cursorId)
      query = query.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) return errorResponse(500, `DB error: ${error.message}`, undefined, headers);
    const rows = (data ?? []) as unknown as VideoRow[];

    const ttlSeconds = 2 * 60 * 60;
    const items = await Promise.all(
      rows.map(async (row) => {
        const title = await aesGcmDecryptEnvelopeB64(row.title_enc, aesKeyB64);
        const presigned = await presignR2GetObject({
          bucket: row.r2_bucket,
          key: row.r2_thumb_key,
          expiresSeconds: ttlSeconds,
        });
        return {
          id: row.id,
          createdAt: row.created_at,
          title,
          durationSeconds: row.duration_seconds,
          width: row.width,
          height: row.height,
          thumbUrl: presigned.url,
          thumbUrlExpiresAt: presigned.expiresAt,
        };
      }),
    );

    const last = items[items.length - 1];
    const nextCursor = last ? { cursorCreatedAt: last.createdAt, cursorId: last.id } : null;

    return jsonResponse(
      200,
      {
        ok: true,
        serverTime: new Date().toISOString(),
        urlTtlSeconds: ttlSeconds,
        refreshSkewSeconds: 10 * 60,
        items,
        nextCursor,
      },
      headers,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return errorResponse(500, message, undefined, { ...corsHeaders, "Cache-Control": "no-store" });
  }
});


