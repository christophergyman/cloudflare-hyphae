import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@hyphae/core";
import type { HubMessage } from "@hyphae/protocol";
import { MemoryFileSystem } from "../src/fs.ts";
import { type ClientTransport, SyncEngine } from "../src/sync.ts";

/**
 * A tiny in-process Hub stand-in that mirrors the HubCore contract: it tracks
 * the current hash per path and broadcasts `changed`. Enough to prove the
 * client engines converge, including echo suppression.
 */
class FakeHub {
  readonly blobs = new Map<string, Uint8Array>();
  private readonly manifest = new Map<string, string>();
  private readonly clients: FakeTransport[] = [];

  connect(engine: SyncEngine): FakeTransport {
    const t = new FakeTransport();
    this.clients.push(t);
    let opened = false;
    t.onOpen(() => {
      opened = true;
    });
    engine.attach(
      t,
      async (hash) => this.blobs.get(hash) ?? null,
      async (bytes) => {
        const h = await sha256Hex(bytes);
        this.blobs.set(h, bytes.slice());
        return h;
      },
    );
    // Simulate an immediate connection open.
    queueMicrotask(() => {
      if (!opened) t.fireOpen();
    });
    return t;
  }

  /** Apply a client change the way the Hub would, and broadcast it. */
  async apply(t: FakeTransport, path: string, newHash: string | null): Promise<void> {
    if (newHash === null) this.manifest.delete(path);
    else this.manifest.set(path, newHash);
    const msg: HubMessage = {
      type: "changed",
      path,
      newHash,
      version: 1,
      by: "peer",
    };
    // Broadcast to everyone except the sender (the sender already has it).
    for (const c of this.clients) {
      if (c === t) continue;
      c.fire({ ...msg });
    }
  }
}

class FakeTransport implements ClientTransport {
  readonly sent: unknown[] = [];
  private msgCb: ((m: HubMessage) => void) | null = null;
  private openCb: (() => void) | null = null;
  private readonly connected: SyncEngine | null = null;

  send(msg: unknown): void {
    this.sent.push(msg);
  }
  onMessage(cb: (m: HubMessage) => void): void {
    this.msgCb = cb;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  fireOpen(): void {
    this.openCb?.();
  }
  fire(msg: HubMessage): void {
    this.msgCb?.(msg);
  }
  get peer(): SyncEngine | null {
    return this.connected;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Narrow a transport's sent messages to the "change" type. */
function sentChanges(transport: FakeTransport): { path: string; newHash: string | null }[] {
  return transport.sent.filter(
    (m): m is { type: "change"; path: string; newHash: string | null } =>
      typeof m === "object" && m !== null && (m as { type?: string }).type === "change",
  );
}

describe("two SyncEngines converge through a Hub", () => {
  it("syncs a file from A to B with no echo", async () => {
    const hub = new FakeHub();
    const fsA = new MemoryFileSystem();
    const fsB = new MemoryFileSystem();
    const rootA = "/a";
    const rootB = "/b";

    const a = new SyncEngine({ actorId: "a", root: rootA, fs: fsA, debounceMs: 1 });
    const b = new SyncEngine({ actorId: "b", root: rootB, fs: fsB, debounceMs: 1 });

    const ta = hub.connect(a);
    hub.connect(b);
    await tick();

    // A writes a file and it is detected.
    fsA.seed(`${rootA}/readme.md`, enc.encode("# hi\n"));
    a.onFileEvent("readme.md");
    await tick();

    // The change was sent to the Hub.
    const change = sentChanges(ta)[0];
    expect(change).toBeDefined();
    expect(change?.path).toBe("readme.md");

    // Hub applies and broadcasts; B receives and writes it.
    await hub.apply(ta, "readme.md", change?.newHash ?? null);
    await tick();

    const onB = await fsB.readFile(`${rootB}/readme.md`);
    expect(onB).not.toBeNull();
    expect(dec.decode(onB as Uint8Array)).toBe("# hi\n");

    // B recorded the write as its own, so it does not echo it back.
    expect(b.queuedCount).toBe(0);
  });

  it("extends: B does not re-send the file it just received", async () => {
    const hub = new FakeHub();
    const fsA = new MemoryFileSystem();
    const fsB = new MemoryFileSystem();
    const a = new SyncEngine({ actorId: "a", root: "/a", fs: fsA, debounceMs: 1 });
    const b = new SyncEngine({ actorId: "b", root: "/b", fs: fsB, debounceMs: 1 });
    const ta = hub.connect(a);
    const tb = hub.connect(b);
    await tick();

    fsA.seed("/a/x.txt", enc.encode("from-a\n"));
    a.onFileEvent("x.txt");
    await tick();
    const change = sentChanges(ta)[0];
    await hub.apply(ta, "x.txt", change?.newHash ?? null);
    await tick();

    // Trigger a watcher event on B for the file B just wrote (the echo).
    b.onFileEvent("x.txt");
    await tick();
    const resent = sentChanges(tb);
    expect(resent.length).toBe(0);
  });
});

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
