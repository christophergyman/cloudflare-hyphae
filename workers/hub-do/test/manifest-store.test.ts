import { describe, expect, it } from "bun:test";
import type { ManifestEntry } from "@hyphae/core";
import {
  LEGACY_MANIFEST_KEY,
  loadManifestEntries,
  MANIFEST_PREFIX,
  type ManifestStorage,
  manifestKey,
  persistManifestEntry,
} from "../src/core.ts";

/** In-memory stand-in for Durable Object storage (get/put/delete/list). */
class FakeStorage implements ManifestStorage {
  private readonly map = new Map<string, unknown>();
  /** Exposed so tests can assert on the raw keys, not just the loaded view. */
  keys(): string[] {
    return [...this.map.keys()];
  }
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue;
      out.set(key, value as T);
    }
    return out;
  }
}

const entry = (version: number): ManifestEntry => ({
  blobHash: `hash-${version}`,
  version,
  updatedBy: "a",
  updatedAt: version,
});

describe("manifest persistence", () => {
  it("stores each path under its own prefixed key", async () => {
    const storage = new FakeStorage();
    await persistManifestEntry(storage, "src/a.ts", entry(1));
    await persistManifestEntry(storage, "README.md", entry(2));
    expect(storage.keys().sort()).toEqual(
      [manifestKey("README.md"), manifestKey("src/a.ts")].sort(),
    );
    expect(storage.keys().every((k) => k.startsWith(MANIFEST_PREFIX))).toBe(true);
  });

  it("reconstructs the same manifest from a fresh load", async () => {
    const storage = new FakeStorage();
    const original: Record<string, ManifestEntry> = {
      "src/a.ts": entry(1),
      "src/b.ts": entry(3),
      "README.md": entry(2),
    };
    for (const [path, e] of Object.entries(original)) {
      await persistManifestEntry(storage, path, e);
    }
    expect(await loadManifestEntries(storage)).toEqual(original);
  });

  it("removes the key on a tombstone so a deleted path is not resurrected", async () => {
    const storage = new FakeStorage();
    await persistManifestEntry(storage, "gone.txt", entry(1));
    await persistManifestEntry(storage, "kept.txt", entry(1));
    expect((await loadManifestEntries(storage))["gone.txt"]).toBeDefined();

    await persistManifestEntry(storage, "gone.txt", undefined);
    const loaded = await loadManifestEntries(storage);
    expect(loaded["gone.txt"]).toBeUndefined();
    expect(loaded["kept.txt"]).toBeDefined();
    expect(storage.keys()).not.toContain(manifestKey("gone.txt"));
  });

  it("ignores unrelated keys when listing", async () => {
    const storage = new FakeStorage();
    await storage.put("manifest:x.txt", entry(1));
    await storage.put("history", [{ kind: "change" }]);
    await storage.put("alarm-state", 42);
    expect(await loadManifestEntries(storage)).toEqual({ "x.txt": entry(1) });
  });

  it("loads an empty manifest when nothing is stored", async () => {
    expect(await loadManifestEntries(new FakeStorage())).toEqual({});
  });

  it("migrates a legacy whole-manifest object to per-path keys", async () => {
    const storage = new FakeStorage();
    const legacy: Record<string, ManifestEntry> = {
      "a.txt": entry(1),
      "b.txt": entry(2),
    };
    await storage.put(LEGACY_MANIFEST_KEY, legacy);

    expect(await loadManifestEntries(storage)).toEqual(legacy);
    // The old key is gone and per-path keys now exist.
    expect(storage.keys()).not.toContain(LEGACY_MANIFEST_KEY);
    expect(storage.keys().sort()).toEqual([manifestKey("a.txt"), manifestKey("b.txt")].sort());
    // A subsequent load reads the migrated form.
    expect(await loadManifestEntries(storage)).toEqual(legacy);
  });
});
