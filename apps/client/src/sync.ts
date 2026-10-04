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
import type { HubMessage } from "@hyphae/protocol";
import { ChangeDetector, type DetectedChange, type SyncedState } from "./detector.ts";
import { applyRemoteChange, type FileSystemPort } from "./paths.ts";

export interface ClientTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: HubMessage) => void): void;
  onOpen(cb: () => void): void;
  onClose?(cb: () => void): void;
}

/** Fetches blob content from R2 (by hash) for applying remote changes. */
export type BlobFetcher = (hash: string) => Promise<Uint8Array | null>;

/** Uploads local content and returns its hash (already content-addressed). */
export type BlobPusher = (bytes: Uint8Array) => Promise<string>;

export interface SyncEngineOptions {
  actorId: string;
  /** Identifies the repo this engine syncs with; sent in the hello handshake. */
  repoId?: string;
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
  private readonly actorId: string;
  private readonly repoId: string;

  /** Journal of changes not yet acknowledged (offline queue, ADR-016). */
  private readonly queued: DetectedChange[] = [];

  constructor(options: SyncEngineOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.actorId = options.actorId;
    this.repoId = options.repoId ?? "";
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
  /** Highest manifest version applied per path, so a stale echo cannot clobber. */
  private readonly appliedVersion = new Map<string, number>();
  /** Guards against overlapping replay runs. */
  private replaying = false;

  attach(transport: ClientTransport, fetchBlob: BlobFetcher, pushBlob: BlobPusher): void {
    this.transport = transport;
    this.fetchBlob = fetchBlob;
    this.pushBlob = pushBlob;

    transport.onOpen(() => {
      this.online = true;
      transport.send({ type: "hello", actorId: this.actorId, repoId: this.repoId });
      void this.replayQueue();
    });
    transport.onClose?.(() => {
      this.online = false;
      this.transport = null;
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
        this.queueOffline(change);
        continue;
      }
      try {
        await this.sendChange(change);
      } catch {
        // A failed send means the change was not delivered: queue it so it is
        // replayed on reconnect instead of being lost.
        this.queueOffline(change);
      }
    }
  }

  /**
   * Queue an offline change, coalescing per path so only the latest state of
   * each file is replayed (ADR-016). The queue is bounded.
   */
  private queueOffline(change: DetectedChange): void {
    const existing = this.queued.findIndex((c) => c.path === change.path);
    if (existing >= 0) this.queued.splice(existing, 1);
    this.queued.push(change);
    if (this.queued.length > 4096) this.queued.shift();
  }

  private async sendChange(change: DetectedChange): Promise<void> {
    if (!this.transport || !this.pushBlob) throw new Error("not connected");
    if (change.kind === "delete") {
      const base = this.synced.get(change.path) ?? null;
      this.transport.send({
        type: "change",
        id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
      path: change.path,
      baseHash: base,
      newHash: hash,
    });
    this.synced.set(change.path, hash);
    // Record our own write so the watcher ignores its echo.
    this.detector.noteOwnWrite(change.path, hash);
  }

  /** Replay queued changes after reconnect (ADR-016). */
  private async replayQueue(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      while (this.queued.length > 0 && this.online) {
        const change = this.queued[0];
        if (!change) break;
        try {
          await this.sendChange(change);
        } catch {
          // Stop and keep the change queued for the next reconnect.
          break;
        }
        this.queued.shift();
      }
    } finally {
      this.replaying = false;
    }
  }

  /** Apply a change broadcast by the Hub to the local working tree. */
  private async handleRemote(msg: HubMessage): Promise<void> {
    if (msg.type === "manifest") {
      for (const [path, entry] of Object.entries(msg.entries)) {
        this.synced.set(path, entry.blobHash);
        this.appliedVersion.set(path, entry.version);
      }
      return;
    }
    if (msg.type === "changed") {
      await this.applyChanged(msg.path, msg.newHash, msg.version);
      return;
    }
    if (msg.type === "resolved") {
      // The merging agent resolved a conflict: apply it like a change.
      await this.applyChanged(msg.path, msg.newHash, Number.MAX_SAFE_INTEGER);
    }
  }

  /**
   * Apply a remote version to disk. Ignores an out-of-order or already-applied
   * version, so a stale echo cannot clobber newer local content.
   */
  private async applyChanged(path: string, newHash: string | null, version: number): Promise<void> {
    if (!this.fetchBlob) return;
    const applied = this.appliedVersion.get(path) ?? -1;
    if (version <= applied) return; // stale: newer content already applied
    if (newHash !== null && this.synced.get(path) === newHash) {
      this.appliedVersion.set(path, Math.max(applied, version));
      return; // already at this exact content
    }
    if (newHash === null) {
      await applyRemoteChange(this.fs, this.root, path, null);
      this.synced.delete(path);
      this.appliedVersion.set(path, version);
      return;
    }
    const bytes = await this.fetchBlob(newHash);
    if (bytes === null) return;
    await applyRemoteChange(this.fs, this.root, path, bytes);
    this.synced.set(path, newHash);
    this.appliedVersion.set(path, version);
    // Our own write: ignore the echo it will trigger.
    this.detector.noteOwnWrite(path, newHash);
  }

  /** Number of changes waiting to be sent. */
  get queuedCount(): number {
    return this.queued.length;
  }

  dispose(): void {
    this.detector.dispose();
  }
}

/** Join a relative path onto the project root, without escaping it. */
function joinRoot(root: string, path: string): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}/${path}`;
}
