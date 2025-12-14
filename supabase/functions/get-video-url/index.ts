/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { requireEnv } from "../_shared/env.ts";
import { aesGcmDecryptEnvelopeB64 } from "../_shared/crypto.ts";
import { extractInitDataFromRequest, verifyTelegramInitData } from "../_shared/telegram.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { presignR2GetObject, requireAesKeyB64 } from "../_shared/r2.ts";
import type { VideoRow } from "../_shared/types.ts";

type VideoUrlRequest = {
  videoId: string;
};

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
      endpoint: "get-video-url",
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
    const body = req.method === "POST" ? await readJson<VideoUrlRequest>(req) : null;
    const videoId = (body?.videoId ?? url.searchParams.get("videoId"))?.trim();
    if (!videoId) return errorResponse(400, "Missing videoId", undefined, headers);

    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .eq("id", videoId)
      .eq("published", true)
      .maybeSingle();

    if (error) return errorResponse(500, `DB error: ${error.message}`, undefined, headers);
    if (!data) return errorResponse(404, "Video not found", undefined, headers);

    const row = data as unknown as VideoRow;
    const ttlSeconds = 2 * 60 * 60;
    const presigned = await presignR2GetObject({
      bucket: row.r2_bucket,
      key: row.r2_video_key,
      expiresSeconds: ttlSeconds,
    });

    const aesKeyB64 = requireAesKeyB64();
    const title = await aesGcmDecryptEnvelopeB64(row.title_enc, aesKeyB64);

    return jsonResponse(
      200,
      {
        ok: true,
        serverTime: new Date().toISOString(),
        urlTtlSeconds: ttlSeconds,
        refreshSkewSeconds: 10 * 60,
        video: {
          id: row.id,
          title,
          durationSeconds: row.duration_seconds,
          width: row.width,
          height: row.height,
          videoUrl: presigned.url,
          videoUrlExpiresAt: presigned.expiresAt,
        },
      },
      headers,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return errorResponse(500, message, undefined, { ...corsHeaders, "Cache-Control": "no-store" });
  }
});


