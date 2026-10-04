import { describe, expect, it } from "bun:test";
import { type Change, sha256Hex } from "@hyphae/core";
import { HubCore } from "../src/core.ts";

/** In-memory blob reader for tests. */
function blobs(entries: Record<string, string>) {
  const map = new Map<string, Uint8Array>();
  for (const [hash, text] of Object.entries(entries)) {
    map.set(hash, new TextEncoder().encode(text));
  }
  return {
    reader: async (hash: string) => map.get(hash) ?? null,
    put(text: string): Promise<string> {
      return sha256Hex(text).then((h) => {
        map.set(h, new TextEncoder().encode(text));
        return h;
      });
    },
  };
}

function change(
  over: Partial<Change> & {
    id: string;
    path: string;
    baseHash: string | null;
    newHash: string | null;
  },
): Change {
  return { repoId: "r", actorId: "a1", ts: 1, ...over };
}

describe("HubCore: clean updates", () => {
  it("accepts a brand new file", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const h = await store.put("hello\n");
    const res = await core.apply(
      change({ id: "c1", path: "a.txt", baseHash: null, newHash: h }),
      store.reader,
    );
    expect(res.status).toBe("accepted");
    expect(res.entry?.blobHash).toBe(h);
    expect(res.entry?.version).toBe(1);
  });

  it("accepts an update whose base matches current", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const h1 = await store.put("v1\n");
    await core.apply(
      change({ id: "c1", path: "a.txt", baseHash: null, newHash: h1 }),
      store.reader,
    );
    const h2 = await store.put("v2\n");
    const res = await core.apply(
      change({ id: "c2", path: "a.txt", baseHash: h1, newHash: h2 }),
      store.reader,
    );
    expect(res.status).toBe("accepted");
    expect(res.entry?.version).toBe(2);
  });

  it("tombstones a deleted file", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const h1 = await store.put("v1\n");
    await core.apply(
      change({ id: "c1", path: "a.txt", baseHash: null, newHash: h1 }),
      store.reader,
    );
    const res = await core.apply(
      change({ id: "c2", path: "a.txt", baseHash: h1, newHash: null }),
      store.reader,
    );
    expect(res.status).toBe("accepted");
    expect(core.get("a.txt")).toBeUndefined();
  });
});

describe("HubCore: collisions", () => {
  it("clean-merges disjoint concurrent edits", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const base = await store.put("a\nb\nc\n");
    await core.apply(
      change({ id: "c1", path: "f.txt", baseHash: null, newHash: base }),
      store.reader,
    );

    // ours: change line 1 ; theirs (already applied): change line 3
    const theirs = await store.put("a\nb\nC\n");
    await core.apply(
      change({ id: "c2", path: "f.txt", baseHash: base, newHash: theirs }),
      store.reader,
    );

    const ours = await store.put("A\nb\nc\n");
    const res = await core.apply(
      change({ id: "c3", path: "f.txt", baseHash: base, newHash: ours }),
      store.reader,
    );
    expect(res.status).toBe("accepted");
    expect(res.mergedContent).toBeDefined();
    const merged = new TextDecoder().decode(res.mergedContent as Uint8Array);
    expect(merged).toBe("A\nb\nC\n");
  });

  it("reports a conflict on overlapping edits", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const base = await store.put("a\nb\nc\n");
    await core.apply(
      change({ id: "c1", path: "f.txt", baseHash: null, newHash: base }),
      store.reader,
    );

    const theirs = await store.put("a\nTHEIRS\nc\n");
    await core.apply(
      change({ id: "c2", path: "f.txt", baseHash: base, newHash: theirs }),
      store.reader,
    );

    const ours = await store.put("a\nOURS\nc\n");
    const res = await core.apply(
      change({ id: "c3", path: "f.txt", baseHash: base, newHash: ours }),
      store.reader,
    );
    expect(res.status).toBe("conflict");
    expect(res.conflict?.path).toBe("f.txt");
  });

  it("reports a conflict for concurrent binary changes (never merges bytes)", async () => {
    const core = new HubCore({ repoId: "r" });
    // binary content (has a NUL byte)
    const binA = new Uint8Array([1, 0, 2]);
    const binB = new Uint8Array([3, 0, 4]);
    const map = new Map<string, Uint8Array>();
    const put = async (bytes: Uint8Array) => {
      const h = await sha256Bytes(bytes);
      map.set(h, bytes);
      return h;
    };
    const reader = async (h: string) => map.get(h) ?? null;

    const base = await put(binA);
    await core.apply(change({ id: "c1", path: "img.png", baseHash: null, newHash: base }), reader);
    const theirs = await put(binB);
    await core.apply(
      change({ id: "c2", path: "img.png", baseHash: base, newHash: theirs }),
      reader,
    );
    const ours = await put(binA);
    const res = await core.apply(
      change({ id: "c3", path: "img.png", baseHash: base, newHash: ours }),
      reader,
    );
    expect(res.status).toBe("conflict");
  });
});

describe("HubCore: idempotency", () => {
  it("returns the same result for a repeated change id and applies once", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const h1 = await store.put("v1\n");
    const c = change({ id: "dup", path: "a.txt", baseHash: null, newHash: h1 });
    const first = await core.apply(c, store.reader);
    const second = await core.apply(c, store.reader);
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(core.get("a.txt")?.version).toBe(1);
  });
});

describe("HubCore: manifest snapshot and hydrate", () => {
  it("round-trips the manifest through hydrate", async () => {
    const core = new HubCore({ repoId: "r" });
    const store = blobs({});
    const h = await store.put("x\n");
    await core.apply(change({ id: "c1", path: "a.txt", baseHash: null, newHash: h }), store.reader);
    const snap = core.manifestEntries();

    const restored = new HubCore({ repoId: "r" });
    restored.hydrate(snap);
    expect(restored.get("a.txt")?.blobHash).toBe(h);
    expect(restored.manifestEntries()).toEqual(snap);
  });
});

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
