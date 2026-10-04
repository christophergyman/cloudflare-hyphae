/**
 * Core domain types for Hyphae.
 *
 * These mirror the data model in the ADR (Part 3). They are intentionally
 * plain and runtime-agnostic: no Node built-ins, no Cloudflare globals.
 */

export type RepoId = string;
export type ActorId = string;
export type ChangeId = string;
export type BlobHash = string;
export type CommitHash = string;

export interface Repo {
  id: RepoId;
  name: string;
  /** Opaque reference to the durable store (an Artifacts repo). */
  storeRef: string;
  /** Default branch name, usually "main". */
  defaultRef: string;
  createdAt: number;
}

/** One row of the Hub manifest: the current version of a single file. */
export interface ManifestEntry {
  blobHash: BlobHash;
  version: number;
  updatedBy: ActorId;
  updatedAt: number;
}

/** The Hub's map of path to current version. Held only in the Hub. */
export interface Manifest {
  entries: Record<string, ManifestEntry>;
}

export type ActorKind = "human" | "agent";

export interface Actor {
  id: ActorId;
  kind: ActorKind;
  displayName: string;
  /** Public key used to verify signed changes (ADR-009). */
  publicKey?: string;
  /** Agents are sponsored by a human. */
  sponsorActorId?: ActorId;
}

/**
 * A single file save. Content is content-addressed and lives in R2, so a
 * change normally carries hashes, not bytes. `content` is present only for
 * small inline messages (ADR-020).
 */
export interface Change {
  id: ChangeId;
  repoId: RepoId;
  actorId: ActorId;
  path: string;
  /** The version the client believed was current. null means new file. */
  baseHash: BlobHash | null;
  /** The new version. null means a tombstone (delete). */
  newHash: BlobHash | null;
  ts: number;
  sig?: string;
}

export type ConflictStatus = "open" | "resolving" | "resolved" | "kept-both";

export interface Conflict {
  id: string;
  repoId: RepoId;
  path: string;
  baseHash: BlobHash | null;
  oursHash: BlobHash;
  theirsHash: BlobHash;
  status: ConflictStatus;
  /** Id of the Workflow resolving this conflict, when one is running. */
  workflowId?: string;
}

/** Revocation list checked by the Hub (ADR-009). */
export interface RemovedActor {
  actorId: ActorId;
  removedAt: number;
}

export const HYPHAE_VERSION = "0.0.0" as const;

export { bytesEqual, sha256Hex, toHex } from "./hash.ts";
export type { MetricPoint, Metrics } from "./metrics.ts";
export { analyticsEngineMetrics, noopMetrics } from "./metrics.ts";
