/**
 * The client watcher daemon (ADR-010).
 *
 * Watches a folder with fs.watch, filters noise (temp files, .git), and feeds
 * real events to the SyncEngine. Incoming changes are applied to disk and
 * ignored on the way back (echo suppression), so two daemons converge.
 *
 * This shell is intentionally thin; all the interesting logic lives in
 * detector.ts, paths.ts, and sync.ts, which are unit-tested.
 */

import { watch } from "node:fs";
import { NodeFileSystem } from "./fs.ts";
import { SyncEngine } from "./sync.ts";

export interface WatcherOptions {
  root: string;
  actorId: string;
  /** Hub base URL, e.g. http://localhost:8787. Enables live sync when set. */
  hub?: string;
  /** Repo name (the Hub agent name). Required with `hub`. */
  repo?: string;
  /** Names/prefixes to ignore (temp files, vcs, build output). */
  ignore?: (path: string) => boolean;
}

const DEFAULT_IGNORE = (path: string): boolean => {
  if (path.includes("/.git/") || path.endsWith("/.git")) return true;
  if (path.includes(".hyphae-tmp-")) return true;
  if (path.includes("/node_modules/")) return true;
  return false;
};

export class Watcher {
  private readonly engine: SyncEngine;
  private readonly ignore: (path: string) => boolean;
  private readonly root: string;
  private readonly hub: string | undefined;
  private readonly repo: string | undefined;
  private readonly actorId: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private socket: WebSocket | null = null;

  constructor(options: WatcherOptions) {
    this.ignore = options.ignore ?? DEFAULT_IGNORE;
    this.root = options.root;
    this.hub = options.hub;
    this.repo = options.repo;
    this.actorId = options.actorId;
    this.engine = new SyncEngine({
      actorId: options.actorId,
      root: options.root,
      fs: new NodeFileSystem(),
    });
  }

  start(): void {
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (this.ignore(rel)) return;
      this.engine.onFileEvent(rel);
    });
    if (this.hub && this.repo) this.connect();
  }

  /**
   * Open a WebSocket to the Hub and wire it to the sync engine. Reconnects on
   * close. Blobs are moved with plain fetch (R2 presigned URLs in production;
   * a direct endpoint here), so only control messages ride the socket.
   */
  private connect(): void {
    const base = this.hub as string;
    const wsUrl = `${base.replace(/^http/, "ws")}/agents/hub/${this.repo}?actorId=${encodeURIComponent(this.actorId)}`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.engine.attach(
        {
          send: (msg) => socket.send(JSON.stringify(msg)),
          onMessage: (cb) => {
            socket.addEventListener("message", (event) => {
              try {
                cb(JSON.parse(String(event.data)));
              } catch {
                // ignore malformed frames
              }
            });
          },
          onOpen: (cb) => cb(),
        },
        async (hash) => {
          const res = await fetch(`${base}/blobs/${hash}`);
          if (!res.ok) return null;
          return new Uint8Array(await res.arrayBuffer());
        },
        async (bytes) => {
          const res = await fetch(`${base}/blobs`, { method: "PUT", body: bytes.slice() });
          const body = (await res.json()) as { hash: string };
          return body.hash;
        },
      );
    });

    socket.addEventListener("close", () => {
      setTimeout(() => this.connect(), 1000);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.socket?.close();
    this.socket = null;
    this.engine.dispose();
  }

  get sync(): SyncEngine {
    return this.engine;
  }
}
