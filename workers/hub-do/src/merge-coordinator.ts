/**
 * Conflict resolution orchestration (ADR-005, ADR-014).
 *
 * Tries the merging agent on a detected conflict. On a clean/verified merge it
 * stores the result, records it, and broadcasts; on keep-both (or no agent) it
 * records the outcome and leaves the conflict surfaced. Nothing is discarded.
 *
 * Pure with respect to the Agent: every effect (core, blob read/write, merge
 * runner, history, persistence, broadcast, checkpointing) is injected, so the
 * Agent only wires dependencies and calls this.
 */

import type { Change, ManifestEntry } from "@hyphae/core";
import { sha256Hex } from "@hyphae/core";
import type { HistoryEvent } from "@hyphae/protocol";
import type { R2BucketLike } from "@hyphae/repostore";
import type { ApplyResult, BlobReader, HubCore } from "./core.ts";

/**
 * Runs a conflict through the merging agent and returns the outcome. In
 * production this is a Workflow; for tests it can be a direct call.
 */
export interface MergeRunner {
  run(job: { repoId: string; path: string; base: string; ours: string; theirs: string }): Promise<{
    status: "merged" | "kept-both";
    content?: string;
    reason?: string;
    /** True when the result was verified by running tests (ADR-014). */
    verified?: boolean;
  }>;
}

/** The effects conflict resolution needs from the Hub. */
export interface MergeCoordinatorDeps {
  repoId: string;
  core: HubCore;
  readBlob: BlobReader;
  /** Stores merged bytes. Absent when R2 is not wired. */
  blobs?: Pick<R2BucketLike, "put">;
  mergeRunner(): MergeRunner | null;
  history: { record(event: HistoryEvent): Promise<void> };
  persistManifest(path: string, entry: ManifestEntry | undefined): Promise<void>;
  broadcast(msg: string): void;
  noteChangeForCheckpoint(): Promise<void>;
}

/**
 * Ask the merging agent to resolve a conflict. On a clean/verified merge, accept
 * and broadcast it. On keep-both (or no agent configured), leave the conflict
 * surfaced; nothing is ever discarded.
 */
export async function tryResolveConflict(
  deps: MergeCoordinatorDeps,
  change: Change,
  result: ApplyResult,
): Promise<void> {
  if (!result.conflict) return;
  const merge = deps.mergeRunner();
  if (!merge) return;

  const read = deps.readBlob;
  const baseBytes = result.conflict.baseHash ? await read(result.conflict.baseHash) : null;
  const oursBytes = result.conflict.oursHash ? await read(result.conflict.oursHash) : null;
  const theirsBytes = result.conflict.theirsHash ? await read(result.conflict.theirsHash) : null;
  if (oursBytes === null || theirsBytes === null) return;

  const decode = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : "");

  let outcome: {
    status: "merged" | "kept-both";
    content?: string;
    reason?: string;
    verified?: boolean;
  };
  try {
    outcome = await merge.run({
      repoId: deps.repoId,
      path: change.path,
      base: decode(baseBytes),
      ours: decode(oursBytes),
      theirs: decode(theirsBytes),
    });
  } catch (err) {
    // Surface the failure instead of swallowing it, so the live view shows why.
    await deps.history.record({
      kind: "conflict",
      path: change.path,
      by: "merging-agent",
      detail: `merge failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      at: Date.now(),
    });
    return;
  }

  if (outcome.status !== "merged" || outcome.content === undefined) {
    // Keep both: the conflict stays surfaced for a human. Nothing is lost.
    await deps.history.record({
      kind: "conflict",
      path: change.path,
      by: "merging-agent",
      detail: `kept both: ${outcome.reason ?? "unresolved"}`.slice(0, 200),
      at: Date.now(),
    });
    return;
  }

  const bytes = new TextEncoder().encode(outcome.content);
  const hash = await sha256Hex(bytes);
  await deps.blobs?.put(hash, bytes);

  const entry = deps.core.applyResolution(
    change.path,
    hash,
    result.conflict.theirsHash,
    "merging-agent",
    Date.now(),
  );
  // If the resolution was stale (the file moved on), do not broadcast it.
  if (entry?.blobHash !== hash) return;
  await deps.persistManifest(change.path, entry);
  await deps.history.record({
    kind: "resolved",
    path: change.path,
    by: "merging-agent",
    detail: outcome.verified ? "resolved and verified" : "resolved by agent",
    at: Date.now(),
  });
  deps.broadcast(
    JSON.stringify({
      type: "resolved",
      changeId: change.id,
      path: change.path,
      newHash: entry?.blobHash ?? hash,
    }),
  );
  await deps.noteChangeForCheckpoint();
}
