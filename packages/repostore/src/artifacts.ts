/// <reference lib="esnext.disposable" />
/**
 * The Artifacts adapter for RepoStore (ADR-007, ADR-018).
 *
 * Artifacts is the durable git history layer. The Artifacts Workers binding can
 * create/fork/inspect repos and mint tokens, but it **cannot read or write
 * files inside a repo**. Commits go through the git protocol, so this adapter
 * uses isomorphic-git with an in-memory filesystem to build a commit and push
 * it over smart HTTP (the path proven by spike 1).
 *
 * This file holds no Node built-ins and no Durable Object types, so it runs in
 * both workerd and Bun. The Artifacts binding and the R2 bucket are injected as
 * structural interfaces.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CommitAuthor, CommitHash, RepoRef, RepoStore, TreeFile } from "./index.ts";
import { MemoryFS } from "./memory-fs.ts";
import type { ArtifactsToken } from "./token.ts";
import { DEFAULT_GIT_USERNAME, tokenSecret } from "./token.ts";
import { fileMatches, replaceTree, stageAll } from "./tree-ops.ts";

export type { ArtifactsToken } from "./token.ts";

/**
 * Minimal structural view of the Artifacts Workers binding.
 *
 * `create` returns plain metadata, not a capability, so it has nothing to
 * release. `get` returns a disposable repo capability; see
 * {@link ArtifactsRepoHandleLike}.
 */
export interface ArtifactsLike {
  create(name: string): Promise<{ name: string; remote: string; token: unknown }>;
  get(name: string): Promise<ArtifactsRepoHandleLike>;
}

/**
 * The repo capability returned by `Artifacts.get`.
 *
 * It is an RPC stub that must be released before the request ends, so the
 * binding docs declare it with `using` (`using repo = await
 * env.ARTIFACTS.get(name)`) and the real handle implements `Disposable` via
 * `[Symbol.dispose]()`. The member is optional here so this minimal,
 * runtime-agnostic interface is still satisfied by fakes and by older bindings
 * that expose no disposal member.
 *
 * @see https://developers.cloudflare.com/artifacts/api/workers-binding/
 */
export interface ArtifactsRepoHandleLike {
  info(): Promise<{ remote: string } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<string | ArtifactsToken>;
  [Symbol.dispose]?(): void;
}

export interface ArtifactsRepoStoreOptions {
  /** How to turn a short-lived token into git Basic auth. */
  username?: string;
  /** Default TTL (seconds) for minted write tokens. */
  tokenTtlSeconds?: number;
}

/**
 * True when a git error means "the ref/object does not exist" (an expected,
 * empty-repo case), as opposed to a real failure. isomorphic-git tags these
 * with `code: "NotFoundError"`; HTTP 404s from the remote are treated the same.
 * Anything else must propagate, so a transient error never looks like data loss.
 *
 * Exported for tests: the classification is the whole point, so it is tested
 * directly rather than only through a live git remote.
 */
export function isMissingRefError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "NotFoundError" || code === "ResolveRefError") return true;
  const status = (err as { statusCode?: unknown }).statusCode;
  return code === "HttpError" && status === 404;
}

/**
 * RepoStore backed by Cloudflare Artifacts.
 *
 * Each repo is created once via the binding, then commits are pushed with
 * isomorphic-git. `writeCommit` takes the full file tree, writes it into an
 * in-memory FS, commits, and pushes to `main`.
 */
export class ArtifactsRepoStore implements RepoStore {
  private readonly remotes = new Map<string, string>();
  /**
   * The working fs+dir from the last write, so reads can see pushed objects.
   * `head` is the commit the worktree is known to be at, used to decide whether
   * a later write can reuse it instead of cloning again.
   */
  private readonly worktrees = new Map<
    string,
    { fs: MemoryFS; dir: string; head: CommitHash | null }
  >();
  private readonly username: string;
  private readonly tokenTtl: number;

  constructor(
    private readonly artifacts: ArtifactsLike,
    options: ArtifactsRepoStoreOptions = {},
  ) {
    this.username = options.username ?? DEFAULT_GIT_USERNAME;
    this.tokenTtl = options.tokenTtlSeconds ?? 3600;
  }

  async createRepo(name: string): Promise<RepoRef> {
    // `create` returns plain metadata (name/remote/token), not a disposable
    // capability, so unlike `get` there is no handle to release here.
    const created = await this.artifacts.create(name);
    this.remotes.set(name, created.remote);
    const token = created.token ? tokenSecret(created.token as string | ArtifactsToken) : undefined;
    return { name, remote: created.remote, token };
  }

  private async remoteFor(repo: string): Promise<string> {
    const cached = this.remotes.get(repo);
    if (cached) return cached;
    const handle = await this.artifacts.get(repo);
    // Release the RPC capability even if info() throws. The binding docs use
    // `using` for this; optional chaining keeps fakes with no disposal working.
    try {
      const info = await handle.info();
      if (!info) throw new Error(`unknown Artifacts repo: ${repo}`);
      this.remotes.set(repo, info.remote);
      return info.remote;
    } finally {
      handle[Symbol.dispose]?.();
    }
  }

  private async writeToken(repo: string): Promise<string> {
    const handle = await this.artifacts.get(repo);
    try {
      const token = await handle.createToken("write", this.tokenTtl);
      return tokenSecret(token);
    } finally {
      handle[Symbol.dispose]?.();
    }
  }

  /**
   * Commit the given tree and push it. Returns the new commit hash.
   *
   * If the repo already has history, it is cloned first so the new commit links
   * to the existing parent (a fast-forward push). Only when the remote is empty
   * do we start from scratch. Files not in `files` are removed from the working
   * tree, so the commit is the complete desired state.
   */
  async writeCommit(
    repo: string,
    parent: CommitHash | null,
    files: TreeFile[],
    message: string,
    author: CommitAuthor,
  ): Promise<CommitHash> {
    const remote = await this.remoteFor(repo);
    const password = await this.writeToken(repo);
    const existingRef = parent ?? (await this.remoteHead(remote, password));

    // Reuse the cached worktree when it is already at the parent commit. This
    // avoids a full clone + full-tree rewrite + re-add of every file on each
    // checkpoint; only changed paths are written and staged. A stale or absent
    // worktree falls back to the clone/init path below.
    const cached = this.worktrees.get(repo);
    if (existingRef && cached && cached.head === existingRef) {
      return this.commitInPlace(cached, files, message, author, remote, password, existingRef);
    }

    const dir = `/repos/${repo}-${crypto.randomUUID().slice(0, 8)}`;
    const fs = new MemoryFS();

    if (existingRef) {
      // Clone the current history so our commit is a descendant of it.
      await git.clone({
        fs,
        http,
        dir,
        url: remote,
        ref: "main",
        singleBranch: true,
        depth: 1,
        onAuth: () => ({ username: this.username, password }),
      });
      // Replace the working tree with the desired state.
      await replaceTree(fs, dir, files);
    } else {
      await git.init({ fs, dir, defaultBranch: "main" });
      for (const file of files) {
        await fs.promises.writeFile(`${dir}/${file.path}`, file.content);
      }
    }

    const staged = await stageAll(fs, dir);
    // A commit is only a no-op when the tree is empty AND nothing was removed.
    if (staged.added.length === 0 && staged.removed.length === 0 && existingRef) {
      this.worktrees.set(repo, { fs, dir, head: existingRef });
      return existingRef;
    }
    const commit = await git.commit({
      fs,
      dir,
      message,
      author: { name: author.name, email: author.email, timestamp: author.timestamp },
    });

    await git.push({
      fs,
      http,
      dir,
      url: remote,
      ref: "main",
      force: false,
      onAuth: () => ({ username: this.username, password }),
    });

    this.worktrees.set(repo, { fs, dir, head: commit });
    return commit;
  }

  /**
   * Commit `files` into an existing worktree, writing and staging only paths
   * whose content actually changed and staging deletions for paths that are
   * gone. The worktree must already be at `parentRef` (checked by the caller).
   */
  private async commitInPlace(
    worktree: { fs: MemoryFS; dir: string; head: CommitHash | null },
    files: TreeFile[],
    message: string,
    author: CommitAuthor,
    remote: string,
    password: string,
    parentRef: CommitHash,
  ): Promise<CommitHash> {
    const { fs, dir } = worktree;
    const desired = new Map(files.map((file) => [file.path, file.content]));

    // Stage deletions for tracked files no longer in the desired tree.
    const removed: string[] = [];
    const tracked = await git.listFiles({ fs, dir });
    for (const path of tracked) {
      if (desired.has(path)) continue;
      await fs.promises.unlink(`${dir}/${path}`).catch(() => {});
      await git.remove({ fs, dir, filepath: path });
      removed.push(path);
    }

    // Write and stage only files whose bytes differ from the working tree.
    const changed: string[] = [];
    for (const [path, content] of desired) {
      if (await fileMatches(fs, `${dir}/${path}`, content)) continue;
      await fs.promises.writeFile(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
      changed.push(path);
    }

    if (changed.length === 0 && removed.length === 0) return parentRef;

    const commit = await git.commit({
      fs,
      dir,
      message,
      author: { name: author.name, email: author.email, timestamp: author.timestamp },
    });

    await git.push({
      fs,
      http,
      dir,
      url: remote,
      ref: "main",
      force: false,
      onAuth: () => ({ username: this.username, password }),
    });

    worktree.head = commit;
    return commit;
  }

  /**
   * Return a filesystem that contains the repo's history, cloning from the
   * remote if we do not already have a worktree from a recent write.
   */
  private async fsFor(
    repo: string,
  ): Promise<{ fs: MemoryFS; dir: string; head: CommitHash | null }> {
    const cached = this.worktrees.get(repo);
    if (cached) return cached;

    const remote = await this.remoteFor(repo);
    const password = await this.writeToken(repo);
    const dir = `/repos/${repo}-read-${crypto.randomUUID().slice(0, 8)}`;
    const fs = new MemoryFS();
    await git.clone({
      fs,
      http,
      dir,
      url: remote,
      ref: "main",
      singleBranch: true,
      depth: 1,
      onAuth: () => ({ username: this.username, password }),
    });
    let head: CommitHash | null = null;
    try {
      head = await git.resolveRef({ fs, dir, ref: "main" });
    } catch (err) {
      if (!isMissingRefError(err)) throw err;
    }
    const entry = { fs, dir, head };
    this.worktrees.set(repo, entry);
    return entry;
  }

  /** The current `main` object id on the remote, or null if the repo is empty. */
  private async remoteHead(remote: string, password: string): Promise<CommitHash | null> {
    try {
      const res = await git.listServerRefs({
        http,
        url: remote,
        onAuth: () => ({ username: this.username, password }),
      });
      const main = res.find((r) => r.ref === "refs/heads/main");
      return main?.oid ?? null;
    } catch (err) {
      // An empty repo legitimately has no refs. Anything else (auth, network,
      // malformed remote) is a real failure we must not disguise as "empty",
      // or the next commit would start from scratch and lose history.
      if (isMissingRefError(err)) return null;
      throw err;
    }
  }

  async readRef(repo: string, ref: string): Promise<CommitHash | null> {
    try {
      const { fs, dir } = await this.fsFor(repo);
      return await git.resolveRef({ fs, dir, ref: ref.replace(/^heads\//, "") });
    } catch (err) {
      if (isMissingRefError(err)) return null;
      throw err;
    }
  }

  async readTree(repo: string, commit: CommitHash): Promise<TreeFile[]> {
    const { fs, dir } = await this.fsFor(repo);
    const oid = commit.replace(/^heads\//, "");
    const paths = await git.listFiles({ fs, dir, ref: oid });
    const out: TreeFile[] = [];
    for (const path of paths) {
      const result = await git.readBlob({ fs, dir, oid, filepath: path });
      out.push({ path, content: result.blob });
    }
    return out;
  }

  async readBlob(repo: string, hash: string): Promise<Uint8Array | null> {
    try {
      const { fs, dir } = await this.fsFor(repo);
      const result = await git.readBlob({ fs, dir, oid: hash });
      return result.blob;
    } catch (err) {
      if (isMissingRefError(err)) return null;
      throw err;
    }
  }

  async updateRef(repo: string, ref: string, hash: CommitHash): Promise<void> {
    void repo;
    void ref;
    void hash;
    // Pushing to `main` already advances the ref on the Artifacts side.
  }
}
