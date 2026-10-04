import { sha256Hex } from "@hyphae/core";
import type {
  BlobStore,
  CommitAuthor,
  CommitHash,
  RepoRef,
  RepoStore,
  StoredCommit,
  TreeFile,
} from "./index.ts";

interface MemoryRepo {
  refs: Map<string, CommitHash>;
  commits: Map<CommitHash, StoredCommit>;
  blobs: Map<string, Uint8Array>;
}

function defaultMode(mode: number | undefined): number {
  return mode ?? 0o100644;
}

/**
 * In-memory RepoStore. Used by tests and by the port suite that the real
 * Artifacts adapter must also pass.
 *
 * Note: commit hashes here are our own content hash, not git object hashes.
 * The Artifacts adapter produces real git hashes; the port only promises
 * stability and uniqueness.
 */
export class MemoryRepoStore implements RepoStore {
  private readonly repos = new Map<string, MemoryRepo>();

  private must(name: string): MemoryRepo {
    const repo = this.repos.get(name);
    if (!repo) throw new Error(`unknown repo: ${name}`);
    return repo;
  }

  async createRepo(name: string): Promise<RepoRef> {
    if (!this.repos.has(name)) {
      this.repos.set(name, { refs: new Map(), commits: new Map(), blobs: new Map() });
    }
    return { name, remote: `memory://${name}` };
  }

  async readRef(repo: string, ref: string): Promise<CommitHash | null> {
    return this.must(repo).refs.get(ref) ?? null;
  }

  async updateRef(repo: string, ref: string, hash: CommitHash): Promise<void> {
    this.must(repo).refs.set(ref, hash);
  }

  async writeCommit(
    repo: string,
    parent: CommitHash | null,
    files: TreeFile[],
    message: string,
    author: CommitAuthor,
  ): Promise<CommitHash> {
    const r = this.must(repo);
    const tree: StoredCommit["tree"] = [];
    for (const file of files) {
      const hash = await sha256Hex(file.content);
      r.blobs.set(hash, file.content);
      tree.push({ path: file.path, blobHash: hash, mode: defaultMode(file.mode) });
    }
    tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const timestamp = author.timestamp ?? Date.now();
    const payload = JSON.stringify({ parent, message, author, timestamp, tree });
    const hash = await sha256Hex(payload);

    const commit: StoredCommit = {
      hash,
      parent,
      message,
      author,
      timestamp,
      tree,
    };
    r.commits.set(hash, commit);
    return hash;
  }

  async readTree(repo: string, commit: CommitHash): Promise<TreeFile[]> {
    const r = this.must(repo);
    const stored = r.commits.get(commit);
    if (!stored) throw new Error(`unknown commit: ${commit}`);
    return stored.tree.map((entry) => {
      const content = r.blobs.get(entry.blobHash);
      if (!content) throw new Error(`missing blob: ${entry.blobHash}`);
      return { path: entry.path, content, mode: entry.mode };
    });
  }

  async readBlob(repo: string, hash: string): Promise<Uint8Array | null> {
    return this.must(repo).blobs.get(hash) ?? null;
  }

  /** Test helper: the stored commit record, if present. */
  peekCommit(repo: string, hash: CommitHash): StoredCommit | null {
    return this.repos.get(repo)?.commits.get(hash) ?? null;
  }
}

/** In-memory content-addressed blob store. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(hash, bytes);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
}
