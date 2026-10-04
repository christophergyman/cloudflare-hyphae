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

/** Minimal structural view of the Artifacts Workers binding. */
export interface ArtifactsLike {
  create(name: string): Promise<{ name: string; remote: string; token: unknown }>;
  get(name: string): Promise<ArtifactsRepoHandleLike>;
}

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

export interface ArtifactsRepoHandleLike {
  info(): Promise<{ remote: string } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<string | ArtifactsToken>;
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
 * Normalize an Artifacts token to the bare secret used for git Basic auth.
 *
 * The workerd binding returns an object (`{ plaintext, ... }`); other paths may
 * return a string. The plaintext looks like `art_v2_<secret>?expires=<unix>`,
 * so strip the query before using it as the password.
 */
function tokenSecret(token: string | ArtifactsToken): string {
  const plaintext = typeof token === "string" ? token : (token?.plaintext ?? "");
  return plaintext.split("?expires=")[0] ?? plaintext;
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
  /** The working fs+dir from the last write, so reads can see pushed objects. */
  private readonly worktrees = new Map<string, { fs: MemoryFS; dir: string }>();
  private readonly username: string;
  private readonly tokenTtl: number;

  constructor(
    private readonly artifacts: ArtifactsLike,
    options: ArtifactsRepoStoreOptions = {},
  ) {
    this.username = options.username ?? "x";
    this.tokenTtl = options.tokenTtlSeconds ?? 3600;
  }

  async createRepo(name: string): Promise<RepoRef> {
    const created = await this.artifacts.create(name);
    this.remotes.set(name, created.remote);
    const token = created.token ? tokenSecret(created.token as string | ArtifactsToken) : undefined;
    return { name, remote: created.remote, token };
  }

  private async remoteFor(repo: string): Promise<string> {
    const cached = this.remotes.get(repo);
    if (cached) return cached;
    const handle = await this.artifacts.get(repo);
    const info = await handle.info();
    if (!info) throw new Error(`unknown Artifacts repo: ${repo}`);
    this.remotes.set(repo, info.remote);
    return info.remote;
  }

  private async writeToken(repo: string): Promise<string> {
    const handle = await this.artifacts.get(repo);
    const token = await handle.createToken("write", this.tokenTtl);
    return tokenSecret(token);
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

    this.worktrees.set(repo, { fs, dir });
    return commit;
  }

  /**
   * Return a filesystem that contains the repo's history, cloning from the
   * remote if we do not already have a worktree from a recent write.
   */
  private async fsFor(repo: string): Promise<{ fs: MemoryFS; dir: string }> {
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
    this.worktrees.set(repo, { fs, dir });
    return { fs, dir };
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

/** Stage every file under `dir` recursively, and stage deletions. */
async function stageAll(
  fs: MemoryFS,
  dir: string,
): Promise<{ added: string[]; removed: string[] }> {
  const added: string[] = [];
  const desired = new Set<string>();

  async function walk(current: string, prefix: string): Promise<void> {
    const names = await fs.promises.readdir(current);
    for (const name of names) {
      if (name === ".git") continue;
      const full = `${current}/${name}`;
      const stat = await fs.promises.lstat(full);
      if (stat.isDirectory()) {
        await walk(full, prefix ? `${prefix}/${name}` : name);
      } else {
        const relative = prefix ? `${prefix}/${name}` : name;
        desired.add(relative);
        await git.add({ fs, dir, filepath: relative });
        added.push(relative);
      }
    }
  }
  await walk(dir, "");

  // Stage removal of tracked files no longer present in the tree.
  const removed: string[] = [];
  const tracked = await git.listFiles({ fs, dir });
  for (const path of tracked) {
    if (!desired.has(path)) {
      await git.remove({ fs, dir, filepath: path });
      removed.push(path);
    }
  }
  return { added, removed };
}

/** Replace the working tree under `dir` with exactly `files`. */
async function replaceTree(fs: MemoryFS, dir: string, files: TreeFile[]): Promise<void> {
  // Remove everything currently in the tree (except .git).
  async function clear(current: string): Promise<void> {
    const names = await fs.promises.readdir(current);
    for (const name of names) {
      if (name === ".git") continue;
      const full = `${current}/${name}`;
      const stat = await fs.promises.lstat(full);
      if (stat.isDirectory()) {
        await clear(full);
        await fs.promises.rmdir(full);
      } else {
        await fs.promises.unlink(full);
      }
    }
  }
  await clear(dir);
  for (const file of files) {
    await fs.promises.writeFile(`${dir}/${file.path}`, file.content);
  }
}
