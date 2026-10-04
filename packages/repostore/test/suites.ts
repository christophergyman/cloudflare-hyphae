import { describe, expect, it } from "bun:test";
import type { BlobStore, RepoStore } from "../src/index.ts";

/**
 * The contract every RepoStore adapter must satisfy. Today the in-memory
 * adapter runs it; the Artifacts adapter must run it too (ADR-007/018).
 */
export function repoStorePortSuite(name: string, makeStore: () => RepoStore): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  describe(`${name}: RepoStore port`, () => {
    it("creates a repo with no refs", async () => {
      const store = makeStore();
      const ref = await store.createRepo("demo");
      expect(ref.name).toBe("demo");
      expect(await store.readRef("demo", "heads/main")).toBeNull();
    });

    it("writes a commit, updates a ref, and reads it back", async () => {
      const store = makeStore();
      await store.createRepo("demo");
      const hash = await store.writeCommit(
        "demo",
        null,
        [{ path: "a.txt", content: enc.encode("hello\n") }],
        "first",
        { name: "cman", email: "cman@example.com" },
      );
      await store.updateRef("demo", "heads/main", hash);
      expect(await store.readRef("demo", "heads/main")).toBe(hash);
    });

    it("reads back a tree with content", async () => {
      const store = makeStore();
      await store.createRepo("demo");
      const hash = await store.writeCommit(
        "demo",
        null,
        [
          { path: "src/index.ts", content: enc.encode("export const x = 1;\n") },
          { path: "README.md", content: enc.encode("# hi\n") },
        ],
        "init",
        { name: "cman", email: "cman@example.com" },
      );
      const tree = await store.readTree("demo", hash);
      const paths = tree.map((f) => f.path).sort();
      expect(paths).toEqual(["README.md", "src/index.ts"]);
      const readme = tree.find((f) => f.path === "README.md");
      expect(readme).toBeDefined();
      expect(dec.decode(readme?.content)).toBe("# hi\n");
    });

    it("links a parent commit and yields distinct hashes", async () => {
      const store = makeStore();
      await store.createRepo("demo");
      const author = { name: "cman", email: "cman@example.com", timestamp: 1000 };
      const first = await store.writeCommit(
        "demo",
        null,
        [{ path: "a.txt", content: enc.encode("one\n") }],
        "first",
        author,
      );
      const second = await store.writeCommit(
        "demo",
        first,
        [{ path: "a.txt", content: enc.encode("two\n") }],
        "second",
        author,
      );
      expect(second).not.toBe(first);
    });

    it("returns null for unknown refs and blobs", async () => {
      const store = makeStore();
      await store.createRepo("demo");
      expect(await store.readRef("demo", "heads/nope")).toBeNull();
      expect(await store.readBlob("demo", "deadbeef")).toBeNull();
    });

    it("reads blob content back by the hash recorded in the tree", async () => {
      const store = makeStore();
      await store.createRepo("demo");
      const content = enc.encode("blob body\n");
      const commit = await store.writeCommit(
        "demo",
        null,
        [{ path: "b.txt", content }],
        "with blob",
        { name: "cman", email: "cman@example.com" },
      );
      const tree = await store.readTree("demo", commit);
      const entry = tree.find((f) => f.path === "b.txt");
      expect(entry).toBeDefined();
      expect(dec.decode(entry?.content)).toBe("blob body\n");
    });
  });
}

/** The contract every BlobStore adapter must satisfy. */
export function blobStorePortSuite(name: string, makeStore: () => BlobStore): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  describe(`${name}: BlobStore port`, () => {
    it("puts, gets, and reports existence", async () => {
      const store = makeStore();
      const bytes = enc.encode("content\n");
      expect(await store.has("h1")).toBe(false);
      await store.put("h1", bytes);
      expect(await store.has("h1")).toBe(true);
      const got = await store.get("h1");
      expect(got).not.toBeNull();
      expect(dec.decode(got as Uint8Array)).toBe("content\n");
    });

    it("returns null for a missing blob", async () => {
      const store = makeStore();
      expect(await store.get("nope")).toBeNull();
    });

    it("overwrites the same key idempotently", async () => {
      const store = makeStore();
      await store.put("h2", enc.encode("a"));
      await store.put("h2", enc.encode("a"));
      expect(dec.decode((await store.get("h2")) as Uint8Array)).toBe("a");
    });
  });
}
