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

/** Minimal structural view of the Artifacts Workers binding. */
export interface ArtifactsLike {
  create(name: string): Promise<{ name: string; remote: string; token: string }>;
  get(name: string): Promise<ArtifactsRepoHandleLike>;
}

export interface ArtifactsRepoHandleLike {
  info(): Promise<{ remote: string } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<string>;
}

/**
 * Minimal in-memory filesystem for isomorphic-git. Vendored from Cloudflare's
 * Artifacts + isomorphic-git example so this package carries no extra deps.
 */
interface Entry {
  kind: "dir" | "file";
  children?: Set<string>;
  data?: Uint8Array;
  mtimeMs: number;
}

/** Node-style filesystem error carrying a `code` isomorphic-git checks for. */
class FsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FsError";
  }
}

class MemoryStats {
  constructor(private readonly entry: Entry) {}
  get size() {
    return this.entry.kind === "file" ? (this.entry.data?.byteLength ?? 0) : 0;
  }
  get mtimeMs() {
    return this.entry.mtimeMs;
  }
  get ctimeMs() {
    return this.entry.mtimeMs;
  }
  get mode() {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }
  isFile() {
    return this.entry.kind === "file";
  }
  isDirectory() {
    return this.entry.kind === "dir";
  }
  isSymbolicLink() {
    return false;
  }
}

export class MemoryFS {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  async readlink(path: string): Promise<string> {
    throw new FsError("ENOENT", `ENOENT: no such file or directory, readlink '${path}'`);
  }
  async symlink(): Promise<void> {
    throw new FsError("EPERM", "EPERM: symlinks are not supported");
  }

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}` || "/";
  }

  private parent(path: string): string {
    const norm = this.normalize(path);
    if (norm === "/") return "/";
    const parts = norm.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private requireEntry(path: string): Entry {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw new FsError("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
    return entry;
  }

  private requireDir(path: string): Entry {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw new FsError("ENOTDIR", `ENOTDIR: not a directory '${path}'`);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw new FsError("ENOENT", `ENOENT: no such file or directory '${parent}'`);
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parent).children?.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? data.slice()
          : new Uint8Array(data);
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.requireDir(this.parent(target)).children?.add(this.basename(target));
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<string | Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file")
      throw new FsError("EISDIR", `EISDIR: illegal operation on a directory '${path}'`);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : (entry.data as Uint8Array);
  }

  async readdir(path: string): Promise<string[]> {
    return [...(this.requireDir(path).children ?? [])].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file")
      throw new FsError("EISDIR", `EISDIR: illegal operation on a directory '${path}'`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children?.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if ((entry.children?.size ?? 0) > 0)
      throw new FsError("ENOTEMPTY", `ENOTEMPTY: directory not empty '${path}'`);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children?.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }
}

export interface ArtifactsRepoStoreOptions {
  /** How to turn a short-lived token into git Basic auth. */
  username?: string;
  /** Default TTL (seconds) for minted write tokens. */
  tokenTtlSeconds?: number;
}

function tokenSecret(token: string): string {
  // Artifacts tokens look like art_v1_<secret>?expires=<unix>.
  return token.split("?expires=")[0] ?? token;
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
    return { name, remote: created.remote, token: created.token };
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
    if (staged.length === 0 && existingRef) {
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
    } catch {
      return null;
    }
  }

  async readRef(repo: string, ref: string): Promise<CommitHash | null> {
    try {
      const { fs, dir } = await this.fsFor(repo);
      return await git.resolveRef({ fs, dir, ref: ref.replace(/^heads\//, "") });
    } catch {
      return null;
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
    } catch {
      return null;
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
async function stageAll(fs: MemoryFS, dir: string): Promise<string[]> {
  const staged: string[] = [];
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
        staged.push(relative);
      }
    }
  }
  await walk(dir, "");

  // Stage removal of tracked files no longer present in the tree.
  const tracked = await git.listFiles({ fs, dir });
  for (const path of tracked) {
    if (!desired.has(path)) {
      await git.remove({ fs, dir, filepath: path });
    }
  }
  return staged;
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
