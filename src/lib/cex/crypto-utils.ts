/**
 * Shared cryptographic utility functions for CEX adapter API signing.
 *
 * Consolidates duplicated HMAC/SHA operations from individual adapter files.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/**
 * HMAC-SHA256, output as hex string.
 * Used by: binance, bybit, bitstamp, cryptocom, coinbase (V2 API).
 */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toHex(sig);
}

/**
 * HMAC-SHA256, output as base64 string.
 * Used by: okx.
 */
export async function hmacSha256Base64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toBase64(sig);
}

/**
 * HMAC-SHA512 with raw bytes input, output as base64 string.
 * Used by: kraken (takes raw secret bytes and raw message bytes).
 */
export async function hmacSha512Base64(
  secretBytes: Uint8Array,
  data: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toBase64(sig);
}

/**
 * SHA-256 digest, returns raw ArrayBuffer.
 * Used by: kraken, volet.
 */
export async function sha256(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(data));
}

/**
 * SHA-256 digest, output as hex string.
 * Used by: volet.
 */
export async function sha256Hex(data: string): Promise<string> {
  const buf = await sha256(data);
  return toHex(buf);
}
