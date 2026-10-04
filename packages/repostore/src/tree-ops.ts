/**
 * Working-tree helpers for the Artifacts adapter.
 *
 * These operate on an in-memory isomorphic-git filesystem: staging every file,
 * checking whether a path already has given bytes, and replacing the tree.
 * Kept separate from the adapter so the git plumbing is testable on its own.
 */

import git from "isomorphic-git";
import type { TreeFile } from "./index.ts";
import type { MemoryFS } from "./memory-fs.ts";

/** Stage every file under `dir` recursively, and stage deletions. */
export async function stageAll(
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

/** True when the file at `path` already has exactly the bytes of `content`. */
export async function fileMatches(
  fs: MemoryFS,
  path: string,
  content: Uint8Array,
): Promise<boolean> {
  try {
    const existing = await fs.promises.readFile(path);
    const bytes = typeof existing === "string" ? new TextEncoder().encode(existing) : existing;
    if (bytes.byteLength !== content.byteLength) return false;
    for (let i = 0; i < bytes.byteLength; i++) {
      if (bytes[i] !== content[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Replace the working tree under `dir` with exactly `files`. */
export async function replaceTree(fs: MemoryFS, dir: string, files: TreeFile[]): Promise<void> {
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
