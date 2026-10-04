/**
 * Change detection (ADR-010).
 *
 * The client watches a folder and fires many events per save. This module turns
 * raw file events into real changes:
 *   - debounces bursts (editors and agents rewrite files repeatedly)
 *   - compares each file's hash against the last synced hash, so a touch that
 *     does not change content is ignored
 *   - ignores writes the client itself made (echo suppression)
 *
 * It is pure and injected (clock + hasher + readers), so it is fully testable
 * without a real filesystem.
 */

export type ChangeKind = "add" | "update" | "delete";

export interface DetectedChange {
  path: string;
  kind: ChangeKind;
  content: Uint8Array;
}

export interface ChangeDetectorOptions {
  /** Wait this long after the last event before emitting a change. */
  debounceMs?: number;
  /** Hash function (sha256 hex). */
  hash: (bytes: Uint8Array) => Promise<string>;
  /** Read a file's bytes, or null if it does not exist. */
  read: (path: string) => Promise<Uint8Array | null>;
}

/** The world as the client last knew it: path -> content hash. */
export type SyncedState = Map<string, string>;

export class ChangeDetector {
  private readonly debounceMs: number;
  private readonly hash: (bytes: Uint8Array) => Promise<string>;
  private readonly read: (path: string) => Promise<Uint8Array | null>;

  /** Hashes of writes this client made itself, so it ignores the echo. */
  private readonly ownWrites = new Set<string>();
  /** Pending debounce timers, keyed by path. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Paths with a pending event, coalesced until the debounce fires. */
  private readonly pending = new Set<string>();
  private synced: SyncedState;
  private onFlush: ((changes: DetectedChange[]) => void) | null = null;

  constructor(synced: SyncedState, options: ChangeDetectorOptions) {
    this.synced = synced;
    this.debounceMs = options.debounceMs ?? 150;
    this.hash = options.hash;
    this.read = options.read;
  }

  /** Register the callback that receives the coalesced changes. */
  onChanges(cb: (changes: DetectedChange[]) => void): void {
    this.onFlush = cb;
  }

  /**
   * Record a hash this client just wrote, so the watcher ignores the resulting
   * event (echo suppression). Called by the sync layer after applying a remote
   * or merged change.
   */
  noteOwnWrite(hash: string): void {
    this.ownWrites.add(hash);
    // Bound the set so it cannot grow forever.
    if (this.ownWrites.size > 1024) {
      const first = this.ownWrites.values().next().value;
      if (first !== undefined) this.ownWrites.delete(first);
    }
  }

  /** Update the known-synced hash for a path (after a successful sync). */
  markSynced(path: string, hash: string | null): void {
    if (hash === null) this.synced.delete(path);
    else this.synced.set(path, hash);
  }

  /**
   * Feed a raw filesystem event. Events for the same path are coalesced and
   * emitted together once the debounce window closes.
   */
  event(path: string, now: number = Date.now()): void {
    this.pending.add(path);
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    void now;
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.flush();
      }, this.debounceMs),
    );
  }

  /** Force the pending events to be processed now (used by tests and shutdown). */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const paths = [...this.pending];
    this.pending.clear();

    const changes: DetectedChange[] = [];
    for (const path of paths) {
      const bytes = await this.read(path);
      if (bytes === null) {
        // File is gone: a delete, unless we never had it.
        if (this.synced.has(path))
          changes.push({ path, kind: "delete", content: new Uint8Array() });
        continue;
      }
      const hash = await this.hash(bytes);
      // Ignore writes we made ourselves (echo).
      if (this.ownWrites.has(hash)) continue;
      const known = this.synced.get(path);
      if (known === hash) continue; // no real change
      changes.push({ path, kind: known === undefined ? "add" : "update", content: bytes });
    }

    if (changes.length > 0 && this.onFlush) this.onFlush(changes);
  }

  /** Stop all pending debounce timers (shutdown). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }
}
