/**
 * Safe local writes (ADR-010, and the path-jail loose end from hyphae-context).
 *
 * Two jobs:
 *   - atomic apply: write to a temp file, then rename, so a reader (an editor or
 *     an agent) never sees a half-written file
 *   - path jail: only ever touch paths inside the project folder
 */

export class PathJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathJailError";
  }
}

const DANGEROUS_SEGMENTS = new Set([".git"]);

/**
 * Resolve `path` (relative) inside `root`, rejecting anything that escapes the
 * project or targets a dangerous location. Throws PathJailError otherwise.
 */
export function resolveSafePath(root: string, path: string): string {
  if (path.length === 0) throw new PathJailError("empty path");
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new PathJailError(`absolute paths are not allowed: ${path}`);
  }
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new PathJailError(`unsafe path segment in: ${path}`);
    }
    if (DANGEROUS_SEGMENTS.has(seg)) {
      throw new PathJailError(`refusing to write into ${seg}: ${path}`);
    }
  }
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${normalizedRoot}/${segments.join("/")}`;
}

/** Abstract the filesystem so the sync logic is testable and runtime-agnostic. */
export interface FileSystemPort {
  readFile(path: string): Promise<Uint8Array | null>;
  writeFileAtomic(path: string, bytes: Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
}

/**
 * Apply a remote change locally: write the bytes, or delete the file.
 * All writes go through the jail and are atomic.
 */
export async function applyRemoteChange(
  fs: FileSystemPort,
  root: string,
  path: string,
  bytes: Uint8Array | null,
): Promise<void> {
  const target = resolveSafePath(root, path);
  if (bytes === null) {
    await fs.unlink(target);
    return;
  }
  await fs.writeFileAtomic(target, bytes);
}
