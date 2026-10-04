import { describe, expect, it } from "bun:test";
import { type ManifestEntry, sha256Hex } from "@hyphae/core";
import { MemoryRepoStore } from "@hyphae/repostore";
import { runCheckpoint } from "../src/checkpoint-runner.ts";

describe("runCheckpoint", () => {
  it("commits every manifest file to the store", async () => {
    const store = new MemoryRepoStore();
    await store.createRepo("demo");

    const blobs = new Map<string, Uint8Array>();
    const entries: Record<string, ManifestEntry> = {};
    for (const [path, text] of [
      ["README.md", "# hi\n"],
      ["src/index.ts", "export const x = 1;\n"],
    ] as const) {
      const bytes = new TextEncoder().encode(text);
      const hash = await sha256Hex(bytes);
      blobs.set(hash, bytes);
      entries[path] = { blobHash: hash, version: 1, updatedBy: "a", updatedAt: 1 };
    }

    const res = await runCheckpoint(store, {
      repo: "demo",
      entries,
      readBlob: async (h) => blobs.get(h) ?? null,
    });

    expect(res.fileCount).toBe(2);
    expect(res.missing).toEqual([]);
    expect(res.commit).toBeTruthy();

    const tree = await store.readTree("demo", res.commit);
    const paths = tree.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "src/index.ts"]);
    expect(new TextDecoder().decode(tree.find((f) => f.path === "README.md")?.content)).toBe(
      "# hi\n",
    );
  });

  it("skips files whose bytes are missing and reports them", async () => {
    const store = new MemoryRepoStore();
    await store.createRepo("demo");
    const res = await runCheckpoint(store, {
      repo: "demo",
      entries: {
        "a.txt": { blobHash: "missing-hash", version: 1, updatedBy: "a", updatedAt: 1 },
      },
      readBlob: async () => null,
    });
    expect(res.fileCount).toBe(0);
    expect(res.missing).toEqual(["a.txt"]);
  });

  it("writes commits in deterministic path order", async () => {
    const store = new MemoryRepoStore();
    await store.createRepo("demo");
    const content = new TextEncoder().encode("x");
    const hash = await sha256Hex(content);
    const readBlob = async () => content;
    const entries: Record<string, ManifestEntry> = {
      "z.txt": { blobHash: hash, version: 1, updatedBy: "a", updatedAt: 1 },
      "a.txt": { blobHash: hash, version: 1, updatedBy: "a", updatedAt: 1 },
    };
    const res = await runCheckpoint(store, { repo: "demo", entries, readBlob });
    const tree = await store.readTree("demo", res.commit);
    expect(tree.map((f) => f.path)).toEqual(["a.txt", "z.txt"]);
  });
});
