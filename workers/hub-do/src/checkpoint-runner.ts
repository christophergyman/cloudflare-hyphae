/**
 * Checkpoint runner (ADR-006, ADR-018).
 *
 * Takes the Hub's current manifest, pulls each file's bytes from R2, and
 * commits the whole tree to Artifacts through the RepoStore. This is the bridge
 * from "live state" to "durable history".
 *
 * Pure and injected (RepoStore + blob reader are interfaces), so it is testable
 * without Cloudflare.
 */

import type { ManifestEntry } from "@hyphae/core";
import type { RepoStore } from "@hyphae/repostore";
import type { BlobReader } from "./core.ts";

export interface CheckpointInput {
  repo: string;
  entries: Record<string, ManifestEntry>;
  readBlob: BlobReader;
  message?: string;
  author?: { name: string; email: string };
}

export interface CheckpointResult {
  /** The new commit hash. */
  commit: string;
  /** How many files were committed. */
  fileCount: number;
  /** Paths whose bytes were missing and therefore skipped. */
  missing: string[];
}

export async function runCheckpoint(
  store: RepoStore,
  input: CheckpointInput,
): Promise<CheckpointResult> {
  const author = input.author ?? { name: "Hyphae Hub", email: "hub@hyphae.dev" };
  const missing: string[] = [];
  const files: { path: string; content: Uint8Array }[] = [];

  // Read blobs with bounded concurrency: a checkpoint over a large repo should
  // not open thousands of R2 reads at once, but sequential awaits make the
  // common case needlessly slow. Chunking keeps the in-flight count bounded and
  // results are consumed in the original (deterministic) entry order.
  const entries = Object.entries(input.entries);
  const CONCURRENCY = 16;
  for (let start = 0; start < entries.length; start += CONCURRENCY) {
    const chunk = entries.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async ([path, entry]) => ({
        path,
        content: await input.readBlob(entry.blobHash),
      })),
    );
    for (const { path, content } of results) {
      if (!content) {
        missing.push(path);
        continue;
      }
      files.push({ path, content });
    }
  }

  // Deterministic order so commits are stable.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const parent = await store.readRef(input.repo, "heads/main");
  const message = input.message ?? defaultMessage(input.repo, files.length);
  const commit = await store.writeCommit(input.repo, parent, files, message, author);

  return { commit, fileCount: files.length, missing };
}

function defaultMessage(repo: string, fileCount: number): string {
  return `checkpoint: ${repo} (${fileCount} file${fileCount === 1 ? "" : "s"})`;
}
