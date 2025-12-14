import { constantTimeEqualHex, hmacSha256, hmacSha256Hex } from "./crypto.ts";

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type VerifiedInitData = {
  raw: string;
  auth_date: number;
  user: TelegramUser;
};

function parseInitDataToMap(initData: string): Map<string, string> {
  const map = new Map<string, string>();
  const params = new URLSearchParams(initData);
  for (const [k, v] of params.entries()) map.set(k, v);
  return map;
}

function buildDataCheckString(map: Map<string, string>): string {
  const pairs: string[] = [];
  const keys = Array.from(map.keys()).filter((k) => k !== "hash").sort();
  for (const k of keys) {
    const v = map.get(k);
    if (typeof v === "string") pairs.push(`${k}=${v}`);
  }
  return pairs.join("\n");
}

/**
 * Telegram initData verification per Web Apps spec.
 * - secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
 * - data_check_string = sorted params (excluding hash), joined by '\n' as key=value
 * - hash = HMAC_SHA256(key=secret_key, msg=data_check_string) hex
 */
export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
): Promise<VerifiedInitData> {
  const map = parseInitDataToMap(initData);
  const providedHash = map.get("hash");
  if (!providedHash) throw new Error("Missing initData hash");

  const authDateStr = map.get("auth_date");
  if (!authDateStr) throw new Error("Missing auth_date");
  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate) || authDate <= 0) throw new Error("Invalid auth_date");

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds < 0) throw new Error("auth_date is in the future");
  if (ageSeconds > maxAgeSeconds) throw new Error("initData is too old");

  const userStr = map.get("user");
  if (!userStr) throw new Error("Missing user field");
  let user: TelegramUser;
  try {
    user = JSON.parse(userStr) as TelegramUser;
  } catch {
    throw new Error("Invalid user JSON");
  }
  if (!user?.id || typeof user.id !== "number") throw new Error("Invalid user.id");

  // secret_key = HMAC("WebAppData", botToken)
  const secretKeyBytes = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    new TextEncoder().encode(botToken),
  );
  const dataCheckString = buildDataCheckString(map);
  const computedHash = await hmacSha256Hex(secretKeyBytes, dataCheckString);

  // Telegram uses lowercase hex for examples; normalize both.
  const ok = constantTimeEqualHex(computedHash, providedHash.toLowerCase());
  if (!ok) throw new Error("Invalid initData signature");

  return { raw: initData, auth_date: authDate, user };
}

export function extractInitDataFromRequest(req: Request): string | null {
  // Preferred: header (keeps URL clean)
  const header = req.headers.get("x-telegram-init-data");
  if (header && header.trim()) return header.trim();

  // Fallback: query param (?initData=...)
  const url = new URL(req.url);
  const q = url.searchParams.get("initData");
  if (q && q.trim()) return q.trim();

  return null;
}


