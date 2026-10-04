/**
 * A minimal in-memory filesystem for isomorphic-git (ADR-018).
 *
 * Vendored from Cloudflare's Artifacts + isomorphic-git example so this
 * package carries no extra Node dependency. Kept in its own module so both
 * the Artifacts adapter and any spike/tooling share one implementation.
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
    const data = entry.data as Uint8Array;
    // Copy on read so a consumer mutating the returned buffer cannot corrupt
    // the stored tree (isomorphic-git may touch buffers during hashing).
    return encoding ? this.decoder.decode(data) : data.slice();
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
