/**
 * HubCore: the framework-agnostic sync authority (ADR-003, ADR-004, ADR-005).
 *
 * HubCore owns the sync decisions and holds no file bytes: it keeps the
 * manifest (path -> current version), detects collisions via the client's
 * baseHash, runs the git 3-way merge fast path (packages/merge), records
 * conflicts for the merging agent, and dedupes changes by id so retries are
 * idempotent.
 *
 * It holds no file bytes (ADR-004): callers hand it blob content only when a
 * merge is needed, and it returns decisions. Keeping it free of Durable Object
 * and Agents SDK types makes it directly unit-testable, which is where the
 * correctness lives.
 */

import {
  type Change,
  type Conflict,
  type ManifestEntry,
  type Metrics,
  noopMetrics,
  sha256Hex,
} from "@hyphae/core";
import { looksBinary, mergeFile } from "@hyphae/merge";

/** Content lookup used only on the merge path. Returns null if unknown. */
export type BlobReader = (hash: string) => Promise<Uint8Array | null>;

export interface ApplyResult {
  /** "accepted": clean update or clean merge. "conflict": needs the agent. */
  status: "accepted" | "conflict" | "duplicate";
  entry?: ManifestEntry;
  conflict?: Conflict;
  /** Merged content when a clean 3-way merge produced it (store as a blob). */
  mergedContent?: Uint8Array;
}

export interface HubCoreOptions {
  repoId: string;
  metrics?: Metrics;
  /** How many changes to remember for dedupe. */
  dedupeSize?: number;
}

export class HubCore {
  private manifest = new Map<string, ManifestEntry>();
  private readonly seen = new Map<string, ApplyResult>();
  private readonly seenOrder: string[] = [];
  private readonly dedupeSize: number;
  private readonly repoId: string;
  private readonly metrics: Metrics;

  constructor(options: HubCoreOptions) {
    this.repoId = options.repoId;
    this.metrics = options.metrics ?? noopMetrics;
    this.dedupeSize = options.dedupeSize ?? 2048;
  }

  /** Snapshot of the manifest for sending to a connecting client. */
  manifestEntries(): Record<string, ManifestEntry> {
    return Object.fromEntries(this.manifest);
  }

  /** Load a persisted manifest (Hub restart / replay, ADR-006). */
  hydrate(entries: Record<string, ManifestEntry>): void {
    this.manifest = new Map(Object.entries(entries));
  }

  get(path: string): ManifestEntry | undefined {
    return this.manifest.get(path);
  }

  /**
   * Apply a change from a client.
   *
   * Idempotent: the same change id returns the same prior result, so a retried
   * message cannot be applied twice (review finding: dedupe by change id).
   */
  async apply(change: Change, readBlob: BlobReader): Promise<ApplyResult> {
    const prior = this.seen.get(change.id);
    if (prior) return { ...prior, status: prior.status };

    const result = await this.applyInner(change, readBlob);
    this.remember(change.id, result);
    return result;
  }

  private async applyInner(change: Change, readBlob: BlobReader): Promise<ApplyResult> {
    const current = this.manifest.get(change.path);
    const currentHash = current?.blobHash ?? null;

    // No collision: base matches current, accept directly.
    if (change.baseHash === currentHash) {
      const entry = this.accept(change.path, change.actorId, change.ts, change.newHash);
      return { status: "accepted", entry };
    }

    // The client's base is already current (they are re-asserting it).
    if (change.newHash !== null && change.newHash === currentHash) {
      return { status: "accepted", entry: current };
    }

    // Collision: someone else changed this file since the client's base.
    // Resolve via git 3-way merge (ADR-005).
    const baseBytes = change.baseHash ? await readBlob(change.baseHash) : null;
    const theirsBytes = currentHash ? await readBlob(currentHash) : null;
    const oursBytes = change.newHash ? await readBlob(change.newHash) : null;

    // If we cannot read the versions, we cannot merge: keep as conflict.
    if (oursBytes === null || (currentHash !== null && theirsBytes === null)) {
      return this.asConflict(change, currentHash);
    }

    // Binary files are never merged (ADR-015).
    const anyBinary = looksBinary(oursBytes) || (theirsBytes !== null && looksBinary(theirsBytes));
    if (anyBinary) {
      return this.asConflict(change, currentHash);
    }

    const baseText = baseBytes ? new TextDecoder().decode(baseBytes) : "";
    const oursText = new TextDecoder().decode(oursBytes);
    const theirsText =
      change.baseHash === null || theirsBytes === null
        ? "" // one side created the file concurrently
        : new TextDecoder().decode(theirsBytes);

    const merged = mergeFile(baseText, oursText, theirsText);
    this.metrics.write({
      index: this.repoId,
      blobs: ["merge", merged.clean ? "clean" : "conflict", change.path],
    });

    if (merged.clean) {
      const mergedContent = new TextEncoder().encode(merged.content);
      const mergedHash = await sha256Hex(mergedContent);
      const entry = this.accept(change.path, change.actorId, change.ts, mergedHash);
      return { status: "accepted", entry, mergedContent };
    }

    return this.asConflict(change, currentHash);
  }

  /** Advance the manifest for a path and return the new entry. */
  private accept(
    path: string,
    actorId: string,
    ts: number,
    newHash: string | null,
  ): ManifestEntry | undefined {
    if (newHash === null) {
      // Tombstone (ADR-015): the path leaves the manifest.
      this.manifest.delete(path);
      this.metrics.write({ index: this.repoId, blobs: ["change", "delete", path] });
      return undefined;
    }
    const prev = this.manifest.get(path);
    const entry: ManifestEntry = {
      blobHash: newHash,
      version: (prev?.version ?? 0) + 1,
      updatedBy: actorId,
      updatedAt: ts,
    };
    this.manifest.set(path, entry);
    this.metrics.write({ index: this.repoId, blobs: ["change", "accept", path] });
    return entry;
  }

  private asConflict(change: Change, currentHash: string | null): ApplyResult {
    const conflict: Conflict = {
      id: `conflict:${change.id}`,
      repoId: this.repoId,
      path: change.path,
      baseHash: change.baseHash,
      oursHash: change.newHash ?? "",
      theirsHash: currentHash ?? "",
      status: "open",
    };
    this.metrics.write({ index: this.repoId, blobs: ["change", "conflict", change.path] });
    return { status: "conflict", conflict };
  }

  /**
   * Record a resolved conflict (after the merging agent), but only if the
   * manifest has not moved on since the conflict was detected. This prevents a
   * stale resolution from overwriting a newer concurrent update (lost update).
   */
  applyResolution(
    path: string,
    newHash: string | null,
    expectedTheirsHash: string | null,
    actorId: string,
    ts: number,
  ): ManifestEntry | undefined {
    const current = this.manifest.get(path)?.blobHash ?? null;
    if (current !== expectedTheirsHash) {
      // The file changed while the agent was working. Do not clobber it.
      this.metrics.write({ index: this.repoId, blobs: ["merge", "stale-resolution", path] });
      return this.manifest.get(path);
    }
    return this.accept(path, actorId, ts, newHash);
  }

  private remember(id: string, result: ApplyResult): void {
    this.seen.set(id, result);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.dedupeSize) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }
}

/**
 * The minimal storage surface manifest persistence needs. It is satisfied
 * structurally by a Durable Object's `storage` (get/put/delete/list) and by the
 * in-memory fake used in tests, so the persistence logic is unit-testable
 * without Cloudflare or the Agents SDK.
 */
export interface ManifestStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

/** Storage-key prefix for per-path manifest entries. */
export const MANIFEST_PREFIX = "manifest:";

/** The old whole-manifest key, kept only so an upgrade can migrate it. */
export const LEGACY_MANIFEST_KEY = "manifest";

/** The storage key for one path's manifest entry. */
export function manifestKey(path: string): string {
  return `${MANIFEST_PREFIX}${path}`;
}

/**
 * Load the whole manifest by listing the `manifest:`-prefixed keys. Per-path
 * keys mean a change only ever writes one entry, rather than rewriting the
 * entire manifest on every accepted change.
 *
 * If no per-path entries exist but the legacy whole-manifest object does, it is
 * migrated to per-path keys (and the old key removed) before returning, so an
 * upgrade never drops an existing manifest.
 */
export async function loadManifestEntries(
  storage: ManifestStorage,
): Promise<Record<string, ManifestEntry>> {
  const stored = await storage.list<ManifestEntry>({ prefix: MANIFEST_PREFIX });
  const entries: Record<string, ManifestEntry> = {};
  for (const [key, entry] of stored) {
    if (!key.startsWith(MANIFEST_PREFIX)) continue;
    entries[key.slice(MANIFEST_PREFIX.length)] = entry;
  }
  if (Object.keys(entries).length > 0) return entries;

  const legacy = await storage.get<Record<string, ManifestEntry>>(LEGACY_MANIFEST_KEY);
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return entries;
  for (const [path, entry] of Object.entries(legacy)) {
    await storage.put(manifestKey(path), entry);
  }
  await storage.delete(LEGACY_MANIFEST_KEY);
  return legacy;
}

/**
 * Persist one path's manifest entry. A tombstone (no entry) deletes the key so
 * a deleted path does not linger and get resurrected on the next load.
 */
export async function persistManifestEntry(
  storage: ManifestStorage,
  path: string,
  entry: ManifestEntry | undefined,
): Promise<void> {
  if (entry === undefined) {
    await storage.delete(manifestKey(path));
    return;
  }
  await storage.put(manifestKey(path), entry);
}
