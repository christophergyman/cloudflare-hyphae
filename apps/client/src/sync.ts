/**
 * The client sync engine (ADR-010, ADR-012).
 *
 * Ties the pieces together, runtime-agnostic and fully testable:
 *   - the change detector finds real local edits
 *   - local changes are sent to the Hub over a transport
 *   - remote `changed` messages are applied to the working tree atomically
 *   - every write it makes is recorded so the watcher ignores the echo
 *
 * The transport is an interface, so tests drive it with a fake and the daemon
 * drives it with a WebSocket.
 */

import { sha256Hex } from "@hyphae/core";
import type { ChangedMessage, HubMessage } from "@hyphae/protocol";
import { ChangeDetector, type DetectedChange, type SyncedState } from "./detector.ts";
import { applyRemoteChange, type FileSystemPort } from "./paths.ts";

export interface ClientTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: HubMessage) => void): void;
  onOpen(cb: () => void): void;
}

/** Fetches blob content from R2 (by hash) for applying remote changes. */
export type BlobFetcher = (hash: string) => Promise<Uint8Array | null>;

/** Uploads local content and returns its hash (already content-addressed). */
export type BlobPusher = (bytes: Uint8Array) => Promise<string>;

export interface SyncEngineOptions {
  actorId: string;
  root: string;
  fs: FileSystemPort;
  detector?: ChangeDetector;
  debounceMs?: number;
}

export class SyncEngine {
  readonly synced: SyncedState = new Map();
  private readonly detector: ChangeDetector;
  private transport: ClientTransport | null = null;
  private fetchBlob: BlobFetcher | null = null;
  private pushBlob: BlobPusher | null = null;
  private readonly root: string;
  private readonly fs: FileSystemPort;

  /** Journal of changes not yet acknowledged (offline queue, ADR-016). */
  private readonly queued: DetectedChange[] = [];

  constructor(options: SyncEngineOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.detector =
      options.detector ??
      new ChangeDetector(this.synced, {
        debounceMs: options.debounceMs ?? 150,
        hash: (bytes) => sha256Hex(bytes),
        read: (path) => this.fs.readFile(joinRoot(options.root, path)),
      });
    this.detector.onChanges((changes) => void this.handleLocalChanges(changes));
  }

  private online = false;

  attach(transport: ClientTransport, fetchBlob: BlobFetcher, pushBlob: BlobPusher): void {
    this.transport = transport;
    this.fetchBlob = fetchBlob;
    this.pushBlob = pushBlob;

    transport.onOpen(() => {
      this.online = true;
      transport.send({ type: "hello", actorId: "", repoId: "" });
      void this.replayQueue();
    });
    transport.onMessage((msg) => void this.handleRemote(msg));
  }

  /** Called by the watcher on every raw filesystem event. */
  onFileEvent(path: string): void {
    this.detector.event(path);
  }

  /** Process a batch of local changes: upload, then tell the Hub. */
  private async handleLocalChanges(changes: DetectedChange[]): Promise<void> {
    for (const change of changes) {
      if (!this.online || !this.transport || !this.pushBlob) {
        this.queued.push(change);
        continue;
      }
      await this.sendChange(change);
    }
  }

  private async sendChange(change: DetectedChange): Promise<void> {
    if (!this.transport || !this.pushBlob) return;
    if (change.kind === "delete") {
      const base = this.synced.get(change.path) ?? null;
      this.transport.send({
        type: "change",
        id: randomId(),
        path: change.path,
        baseHash: base,
        newHash: null,
      });
      this.synced.delete(change.path);
      return;
    }
    const hash = await this.pushBlob(change.content);
    const base = this.synced.get(change.path) ?? null;
    this.transport.send({
      type: "change",
      id: randomId(),
      path: change.path,
      baseHash: base,
      newHash: hash,
    });
    this.synced.set(change.path, hash);
    // Record our own write so the watcher ignores its echo.
    this.detector.noteOwnWrite(hash);
  }

  /** Replay queued changes after reconnect (ADR-016). */
  private async replayQueue(): Promise<void> {
    while (this.queued.length > 0) {
      const change = this.queued.shift();
      if (change) await this.sendChange(change);
    }
  }

  /** Apply a change broadcast by the Hub to the local working tree. */
  private async handleRemote(msg: HubMessage): Promise<void> {
    if (msg.type === "manifest") {
      for (const [path, entry] of Object.entries(msg.entries)) {
        this.synced.set(path, entry.blobHash);
      }
      return;
    }
    if (msg.type === "changed") {
      await this.applyChanged(msg);
    }
  }

  private async applyChanged(msg: ChangedMessage): Promise<void> {
    if (!this.fetchBlob) return;
    if (msg.newHash === null) {
      await applyRemoteChange(this.fs, this.root, msg.path, null);
      this.synced.delete(msg.path);
      return;
    }
    const bytes = await this.fetchBlob(msg.newHash);
    if (bytes === null) return;
    await applyRemoteChange(this.fs, this.root, msg.path, bytes);
    this.synced.set(msg.path, msg.newHash);
    // Our own write: ignore the echo it will trigger.
    this.detector.noteOwnWrite(msg.newHash);
  }

  /** Number of changes waiting to be sent. */
  get queuedCount(): number {
    return this.queued.length;
  }

  dispose(): void {
    this.detector.dispose();
  }
}

function randomId(): string {
  return crypto.randomUUID();
}

/** Join a relative path onto the project root, without escaping it. */
function joinRoot(root: string, path: string): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}/${path}`;
}
