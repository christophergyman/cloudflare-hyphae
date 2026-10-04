/**
 * Pure helpers for the Hub. Kept out of `index.ts` so the Agent class stays a
 * thin transport shell and these can be reasoned about (and unit-tested) alone.
 */

import { parseClientMessage } from "@hyphae/protocol";

/** Parse an incoming client message, returning a typed error instead of throwing. */
export function parseClientMessageSafe(
  raw: unknown,
): { ok: true; value: ReturnType<typeof parseClientMessage> } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseClientMessage(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid message" };
  }
}

/**
 * True when an error means "the repo already exists", the one create failure
 * that is safe to ignore. Matches the Artifacts API's conflict signal (HTTP
 * 409), and any message that says so, without swallowing unrelated failures
 * such as a genuine bad request.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status =
    (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  if (status === 409) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /already exists|conflict/i.test(message);
}

/** Decode base64 (used for small inline file content, ADR-020). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
