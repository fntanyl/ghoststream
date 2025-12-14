function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

export async function hmacSha256(
  keyBytes: Uint8Array,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(
  keyBytes: Uint8Array,
  message: string,
): Promise<string> {
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = await hmacSha256(keyBytes, msgBytes);
  return bytesToHex(sigBytes);
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type AesGcmEnvelopeV1 = {
  v: 1;
  alg: "A256GCM";
  iv_b64: string; // 12 bytes recommended
  ct_b64: string; // ciphertext + tag, as produced by AESGCM in many libs
};

export async function aesGcmDecryptEnvelopeB64(
  envelopeB64: string,
  keyB64: string,
): Promise<string> {
  const envJson = new TextDecoder().decode(base64ToBytes(envelopeB64));
  const env = JSON.parse(envJson) as Partial<AesGcmEnvelopeV1>;
  if (!env || env.v !== 1 || env.alg !== "A256GCM" || !env.iv_b64 || !env.ct_b64) {
    throw new Error("Invalid encryption envelope");
  }

  const keyBytes = base64ToBytes(keyB64);
  if (keyBytes.byteLength !== 32) throw new Error("AES key must be 32 bytes (base64)");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const iv = base64ToBytes(env.iv_b64);
  const ct = base64ToBytes(env.ct_b64);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

export async function aesGcmEncryptEnvelopeB64(
  plaintext: string,
  keyB64: string,
): Promise<string> {
  const keyBytes = base64ToBytes(keyB64);
  if (keyBytes.byteLength !== 32) throw new Error("AES key must be 32 bytes (base64)");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, ptBytes);
  const env: AesGcmEnvelopeV1 = {
    v: 1,
    alg: "A256GCM",
    iv_b64: bytesToBase64(iv),
    ct_b64: bytesToBase64(new Uint8Array(ctBuf)),
  };
  const envB64 = bytesToBase64(new TextEncoder().encode(JSON.stringify(env)));
  return envB64;
}

export function normalizeTagToken(tag: string): string {
  return tag.trim().toLowerCase();
}

export function b64ToBytes(b64: string): Uint8Array {
  return base64ToBytes(b64);
}


