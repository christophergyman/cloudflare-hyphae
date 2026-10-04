import { describe, expect, it } from "bun:test";
import { type Change, sha256Hex } from "@hyphae/core";
import { HubCore } from "../src/core.ts";

/**
 * End-to-end-ish sync test: two simulated clients talking to one HubCore, the
 * way the WebSocket layer drives it. Proves convergence, which is the whole
 * product promise, without needing a Durable Object.
 */

interface Client {
  actorId: string;
  /** Last version this client believes is current, per path. */
  lastKnown: Map<string, string | null>;
  /** Content it has locally, per path. */
  files: Map<string, string>;
}

class SharedBlobs {
  private map = new Map<string, string>();
  async put(text: string): Promise<string> {
    const h = await sha256Hex(text);
    this.map.set(h, text);
    return h;
  }
  reader = async (hash: string): Promise<Uint8Array | null> => {
    const text = this.map.get(hash);
    return text === undefined ? null : new TextEncoder().encode(text);
  };
}

function commit(core: HubCore, blobs: SharedBlobs, client: Client, path: string, content: string) {
  return blobs.put(content).then((newHash) =>
    core
      .apply(
        {
          id: crypto.randomUUID(),
          repoId: "r",
          actorId: client.actorId,
          path,
          baseHash: client.lastKnown.get(path) ?? null,
          newHash,
          ts: Date.now(),
        } satisfies Change,
        blobs.reader,
      )
      .then((res) => {
        const hash = res.entry?.blobHash ?? newHash;
        client.lastKnown.set(path, hash);
        client.files.set(path, content);
        return res;
      }),
  );
}

describe("two clients through one HubCore", () => {
  it("converges when a second client edits after learning the first", async () => {
    const core = new HubCore({ repoId: "r" });
    const blobs = new SharedBlobs();
    const a: Client = { actorId: "a", lastKnown: new Map(), files: new Map() };
    const b: Client = { actorId: "b", lastKnown: new Map(), files: new Map() };

    // A creates the file.
    const first = await commit(core, blobs, a, "readme.md", "# hello\n");
    expect(first.status).toBe("accepted");
    // B learns A's version before editing.
    b.lastKnown.set("readme.md", first.entry?.blobHash ?? null);

    // B edits from the learned version: no conflict, the version advances.
    const second = await commit(core, blobs, b, "readme.md", "# hello from b\n");
    expect(second.status).toBe("accepted");

    // A catches up to the hub, and both clients agree with it.
    const hubHash = core.get("readme.md")?.blobHash ?? null;
    a.lastKnown.set("readme.md", hubHash);
    expect(core.get("readme.md")?.version).toBe(2);
    expect(a.lastKnown.get("readme.md")).toBe(hubHash);
    expect(b.lastKnown.get("readme.md")).toBe(hubHash);
    // The hub's current version is exactly B's edit, and both clients agree.
    expect(hubHash).toBe(await sha256Hex("# hello from b\n"));
  });

  it("converges when both edit disjoint sections of the same file", async () => {
    const core = new HubCore({ repoId: "r" });
    const blobs = new SharedBlobs();
    const a: Client = { actorId: "a", lastKnown: new Map(), files: new Map() };
    const b: Client = { actorId: "b", lastKnown: new Map(), files: new Map() };

    // Both start from the same base.
    const base = await commit(core, blobs, a, "f.txt", "one\ntwo\nthree\n");
    b.lastKnown.set("f.txt", base.entry?.blobHash ?? null);

    // A edits the first line.
    const ra = await commit(core, blobs, a, "f.txt", "ONE\ntwo\nthree\n");
    expect(ra.status).toBe("accepted");

    // B, unaware of A, edits the last line from the same base.
    const rb = await core.apply(
      {
        id: "b-1",
        repoId: "r",
        actorId: "b",
        path: "f.txt",
        baseHash: base.entry?.blobHash ?? null,
        newHash: await blobs.put("one\ntwo\nTHREE\n"),
        ts: Date.now(),
      },
      blobs.reader,
    );
    expect(rb.status).toBe("accepted");
    expect(rb.mergedContent).toBeDefined();
    expect(new TextDecoder().decode(rb.mergedContent as Uint8Array)).toBe("ONE\ntwo\nTHREE\n");
  });

  it("surfaces a conflict when both edit the same line", async () => {
    const core = new HubCore({ repoId: "r" });
    const blobs = new SharedBlobs();
    const a: Client = { actorId: "a", lastKnown: new Map(), files: new Map() };

    const base = await commit(core, blobs, a, "f.txt", "keep\nedit-me\nkeep\n");
    const ra = await commit(core, blobs, a, "f.txt", "keep\nA-VERSION\nkeep\n");
    expect(ra.status).toBe("accepted");

    const rb = await core.apply(
      {
        id: "b-1",
        repoId: "r",
        actorId: "b",
        path: "f.txt",
        baseHash: base.entry?.blobHash ?? null,
        newHash: await blobs.put("keep\nB-VERSION\nkeep\n"),
        ts: Date.now(),
      },
      blobs.reader,
    );
    expect(rb.status).toBe("conflict");
    expect(rb.conflict?.oursHash).toBeTruthy();
    expect(rb.conflict?.theirsHash).toBeTruthy();
  });
});
