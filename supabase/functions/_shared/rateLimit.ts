import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type RateLimitResult =
  | { ok: true; remaining: number; limit: number; resetAt: string }
  | { ok: false; retryAfterSeconds: number; limit: number; resetAt: string };

export async function enforceRateLimit(params: {
  supabase: SupabaseClient;
  tgUserId: number;
  endpoint: string;
  limitPerMinute?: number; // default 30
  windowSeconds?: number; // default 60
}): Promise<RateLimitResult> {
  const limit = params.limitPerMinute ?? 30;
  const windowSeconds = params.windowSeconds ?? 60;
  const now = Date.now();
  const windowStart = new Date(now - windowSeconds * 1000).toISOString();
  // NOTE: `resetAt` should be interpreted as "when you can retry without exceeding the limit".
  // In a true sliding window, this depends on the oldest request that is still inside the window.
  // We compute it precisely in the rate-limited path below.
  const resetAt = new Date(now + windowSeconds * 1000).toISOString();

  // 1) Insert this request into the sliding window ledger.
  const insertRes = await params.supabase.from("api_requests").insert({
    tg_user_id: params.tgUserId,
    endpoint: params.endpoint,
  });
  if (insertRes.error) {
    // Fail closed: if rate limiting storage fails, deny to avoid abuse.
    throw new Error(`Rate limit insert failed: ${insertRes.error.message}`);
  }

  // 2) Count requests in the last N seconds (sliding window).
  const countRes = await params.supabase
    .from("api_requests")
    .select("id", { count: "exact", head: true })
    .eq("tg_user_id", params.tgUserId)
    .gte("created_at", windowStart);

  if (countRes.error) {
    throw new Error(`Rate limit count failed: ${countRes.error.message}`);
  }
  const count = countRes.count ?? 0;

  if (count > limit) {
    // Sliding window precision: find the request timestamp that must expire for the
    // user to be back within limit.
    //
    // If we have `count` requests in the last window, we need `(count - limit)` requests
    // to fall out. The time to wait corresponds to the (count - limit)-th request to expire,
    // which is the request at index (count - limit - 1) in ascending order.
    const overflow = count - limit;
    const idx = Math.max(0, overflow - 1);

    const oldestRes = await params.supabase
      .from("api_requests")
      .select("created_at")
      .eq("tg_user_id", params.tgUserId)
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .range(idx, idx)
      .maybeSingle();

    // Fallback if we can't compute precisely.
    let retryAfterSeconds = windowSeconds;
    let preciseResetAt = resetAt;

    const oldestCreatedAt = (oldestRes.data as { created_at?: string } | null)?.created_at;
    if (!oldestRes.error && oldestCreatedAt) {
      const oldestMs = Date.parse(oldestCreatedAt);
      if (Number.isFinite(oldestMs)) {
        const waitMs = oldestMs + windowSeconds * 1000 - now;
        retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        preciseResetAt = new Date(oldestMs + windowSeconds * 1000).toISOString();
      }
    }

    return {
      ok: false,
      retryAfterSeconds,
      limit,
      resetAt: preciseResetAt,
    };
  }

  return {
    ok: true,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt,
  };
}


