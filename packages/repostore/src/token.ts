/**
 * Artifacts token handling (ADR-018).
 *
 * The Artifacts binding returns a token object in workerd; older or other
 * adapters may return a bare string. This module normalizes both to the secret
 * used for git Basic auth and names the username those tokens expect.
 */

/**
 * The token shape returned by the Artifacts binding's `createToken`.
 *
 * In workerd the binding returns an object (`{ id, plaintext, scope, expiresAt }`),
 * not a bare string. Older/other adapters may return a plain string, so both
 * are accepted and normalized by {@link tokenSecret}.
 */
export interface ArtifactsToken {
  id?: string;
  plaintext: string;
  scope?: string;
  expiresAt?: string;
}

/**
 * Git Basic-auth username for Artifacts tokens.
 *
 * Artifacts authenticates on the token alone and ignores the username, so any
 * non-empty value works; "x" is the conventional placeholder.
 */
export const DEFAULT_GIT_USERNAME = "x";

/**
 * Normalize an Artifacts token to the bare secret used for git Basic auth.
 *
 * The workerd binding returns an object (`{ plaintext, ... }`); other paths may
 * return a string. The plaintext looks like `art_v2_<secret>?expires=<unix>`,
 * so strip the query before using it as the password.
 */
export function tokenSecret(token: string | ArtifactsToken): string {
  const plaintext = typeof token === "string" ? token : (token?.plaintext ?? "");
  return plaintext.split("?expires=")[0] ?? plaintext;
}
