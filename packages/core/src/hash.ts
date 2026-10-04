/**
 * Content hashing. Uses WebCrypto so it runs identically in workerd and Bun.
 */

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Lowercase hex SHA-256 of the given bytes or UTF-8 string. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  // Copy into a standalone ArrayBuffer so the BufferSource type is exact.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return toHex(new Uint8Array(digest));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
