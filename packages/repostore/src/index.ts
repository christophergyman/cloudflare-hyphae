/**
 * Storage ports (ADR-007, ADR-018, ADR-020).
 *
 * Two separate concerns:
 *   - RepoStore: durable git history (the Artifacts adapter).
 *   - BlobStore: content-addressed file bytes (the R2 adapter).
 *
 * The core depends on these interfaces only. Artifacts and R2 are adapters.
 */

export interface RepoRef {
  name: string;
  /** Git remote URL, for adapters that expose one. */
  remote: string;
  /** Short-lived token when the adapter mints one. */
  token?: string;
}

export type CommitHash = string;

export interface TreeFile {
  path: string;
  content: Uint8Array;
  /** POSIX mode, default 0o100644. */
  mode?: number;
}

export interface CommitAuthor {
  name: string;
  email: string;
  timestamp?: number;
}

export interface StoredCommit {
  hash: CommitHash;
  parent: CommitHash | null;
  message: string;
  author: CommitAuthor;
  timestamp: number;
  /** Path to blob hash, mode. Content is not stored in the commit. */
  tree: { path: string; blobHash: string; mode: number }[];
}

/**
 * Durable, versioned history. Commits are small: callers pass the file
 * contents to include (usually read from the BlobStore) and get back a hash.
 */
export interface RepoStore {
  createRepo(name: string): Promise<RepoRef>;
  /** Current hash of a ref, or null if the ref does not exist. */
  readRef(repo: string, ref: string): Promise<CommitHash | null>;
  writeCommit(
    repo: string,
    parent: CommitHash | null,
    files: TreeFile[],
    message: string,
    author: CommitAuthor,
  ): Promise<CommitHash>;
  readTree(repo: string, commit: CommitHash): Promise<TreeFile[]>;
  readBlob(repo: string, hash: string): Promise<Uint8Array | null>;
  updateRef(repo: string, ref: string, hash: CommitHash): Promise<void>;
}

/** Content-addressed file bytes. The Hub never holds these (ADR-004). */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
}

export type {
  ArtifactsLike,
  ArtifactsRepoHandleLike,
  ArtifactsRepoStoreOptions,
  ArtifactsToken,
} from "./artifacts.ts";
export { ArtifactsRepoStore } from "./artifacts.ts";
export { MemoryFS } from "./memory-fs.ts";
export { MemoryBlobStore, MemoryRepoStore } from "./memory.ts";
export type { R2BucketLike } from "./r2.ts";
export { R2BlobStore } from "./r2.ts";
