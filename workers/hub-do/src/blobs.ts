/**
 * Blob access for the Hub (ADR-004, ADR-020).
 *
 * Content lives in R2. The Hub reads blobs only on the merge path, and stores
 * small inline files as blobs before recording their hash. These helpers take
 * the BLOBS binding directly, so they hold no Agent state.
 */

import { sha256Hex } from "@hyphae/core";
import type { R2BucketLike } from "@hyphae/repostore";
import type { BlobReader } from "./core.ts";
import { base64ToBytes } from "./helpers.ts";

/** A {@link BlobReader} backed by the R2 bucket. Returns null when absent. */
export function blobReader(bucket: R2BucketLike | undefined): BlobReader {
  return async (hash: string) => {
    if (!bucket) return null;
    const obj = await bucket.get(hash);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  };
}

/** Store inline base64 content as a content-addressed blob; return its hash. */
export async function storeInline(
  bucket: R2BucketLike | undefined,
  base64: string,
): Promise<string> {
  const bytes = base64ToBytes(base64);
  const hash = await sha256Hex(bytes);
  await bucket?.put(hash, bytes);
  return hash;
}
