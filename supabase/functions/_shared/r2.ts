import { b64ToBytes, hmacSha256 } from "./crypto.ts";
import { requireEnv } from "./env.ts";

type PresignGetParams = {
  bucket: string;
  key: string;
  expiresSeconds: number; // e.g. 7200
};

function encodeRfc3986(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalizePath(key: string): string {
  // S3 canonical URI requires each path segment to be URI-encoded.
  const segments = key.split("/").map((s) => encodeRfc3986(s));
  return "/" + segments.join("/");
}

function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mm = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  return { amzDate: `${y}${m}${d}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${d}` };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    new TextEncoder().encode(dateStamp),
  );
  const kRegion = await hmacSha256(kDate, new TextEncoder().encode(region));
  const kService = await hmacSha256(kRegion, new TextEncoder().encode(service));
  const kSigning = await hmacSha256(kService, new TextEncoder().encode("aws4_request"));
  return kSigning;
}

function buildCanonicalQuery(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  return keys
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k] ?? "")}`)
    .join("&");
}

/**
 * Creates a presigned GET URL for a private R2 object (S3 SigV4).
 *
 * Env required:
 * - R2_ACCESS_KEY_ID
 * - R2_SECRET_ACCESS_KEY
 * - R2_ACCOUNT_ID
 * - R2_REGION (optional; default "auto")
 */
export async function presignR2GetObject(params: PresignGetParams): Promise<{
  url: string;
  expiresAt: string;
}> {
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const region = Deno.env.get("R2_REGION") ?? "auto";
  const endpoint = Deno.env.get("R2_ENDPOINT") ??
    `https://${accountId}.r2.cloudflarestorage.com`;

  const now = new Date();
  const { amzDate, dateStamp } = toAmzDate(now);
  const expiresSeconds = params.expiresSeconds;
  const expiresAt = new Date(now.getTime() + expiresSeconds * 1000).toISOString();

  const host = new URL(endpoint).host;
  const service = "s3";

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  const canonicalUri = `/${encodeRfc3986(params.bucket)}${canonicalizePath(params.key)}`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = buildCanonicalQuery(query);

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalRequestHash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, new TextEncoder().encode(stringToSign));
  const signatureHex = Array.from(signatureBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  const finalQuery = `${canonicalQuery}&X-Amz-Signature=${signatureHex}`;
  const url = `${endpoint}${canonicalUri}?${finalQuery}`;

  return { url, expiresAt };
}

export function requireTagHmacKeyBytes(): Uint8Array {
  const keyB64 = requireEnv("TAG_HMAC_KEY_B64");
  return b64ToBytes(keyB64);
}

export function requireAesKeyB64(): string {
  return requireEnv("AES_KEY_B64");
}


