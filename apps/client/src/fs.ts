/**
 * Filesystem implementations for the client.
 *
 * `NodeFileSystem` uses node:fs (Bun/Node runtime). `MemoryFileSystem` is used
 * by tests. Both implement the same port so the sync logic is runtime-agnostic.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileSystemPort } from "./paths.ts";

export class NodeFileSystem implements FileSystemPort {
  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  }

  /** Write to a sibling temp file, then rename, so readers see a whole file. */
  async writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.hyphae-tmp-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async unlink(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async list(): Promise<string[]> {
    return [];
  }
}

/** In-memory filesystem for tests. */
export class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, Uint8Array>();

  /** Seed a file directly (test setup). */
  seed(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes ? bytes.slice() : null;
  }

  async writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
}
