import { describe, expect, it } from "bun:test";
import { MemoryBlobStore, R2BlobStore, type R2BucketLike } from "../src/index.ts";
import { blobStorePortSuite } from "./suites.ts";

blobStorePortSuite("in-memory", () => new MemoryBlobStore());

/** A tiny in-memory stand-in for an R2 bucket binding. */
function fakeBucket(): R2BucketLike {
  const map = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      map.set(key, value);
      return {};
    },
    async get(key) {
      const value = map.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value.slice().buffer as ArrayBuffer };
    },
    async head(key) {
      return map.has(key) ? {} : null;
    },
  };
}

blobStorePortSuite("r2 (fake bucket)", () => new R2BlobStore(fakeBucket()));

describe("R2BlobStore", () => {
  it("round-trips bytes through the bucket", async () => {
    const store = new R2BlobStore(fakeBucket());
    const bytes = new TextEncoder().encode("through r2\n");
    await store.put("abc", bytes);
    expect(await store.has("abc")).toBe(true);
    const got = await store.get("abc");
    expect(new TextDecoder().decode(got as Uint8Array)).toBe("through r2\n");
  });
});
