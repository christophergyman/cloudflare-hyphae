/**
 * The Hub: one Agents SDK `Agent` per repo (ADR-017, ADR-019).
 *
 * This class is a thin transport + persistence shell around {@link HubCore},
 * which holds all the sync logic. Responsibilities here:
 *   - accept WebSocket connections and speak the Hyphae protocol (ADR-012)
 *   - persist the manifest in SQLite-backed Durable Object storage (ADR-019)
 *   - broadcast changes to connected clients
 *   - record presence
 *
 * Content lives in R2 (ADR-004): `env.BLOBS` is read only on the merge path.
 */

import type { Change, ManifestEntry } from "@hyphae/core";
import { parseClientMessage } from "@hyphae/protocol";
import type { RepoStore } from "@hyphae/repostore";
import { Agent } from "agents";
import { CheckpointScheduler } from "./checkpoint.ts";
import { runCheckpoint } from "./checkpoint-runner.ts";
import { type BlobReader, HubCore, type HubCoreOptions } from "./core.ts";

export interface HubEnv {
  /** Content-addressed blob store (ADR-004). */
  BLOBS?: R2BucketLike;
  /**
   * Durable history. Left optional so the Hub runs (live-only) without
   * Artifacts wired up; checkpoints are simply skipped when absent.
   */
  REPO_STORE?: RepoStore;
}

/** Minimal R2 surface the Hub needs (keeps this free of binding types). */
export interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
}

/** Per-connection state, persisted with the hibernating WebSocket. */
export interface ConnectionState {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
}

const MANIFEST_KEY = "manifest";
/** Artifacts repo name used for this Hub's checkpoints. */
const STORE_REPO = "main";

export class Hub extends Agent<HubEnv, Record<string, never>> {
  private core: HubCore | null = null;
  private readonly checkpoints = new CheckpointScheduler();

  constructor(ctx: ConstructorParameters<typeof Agent>[0], env: HubEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await this.loadManifest();
    });
  }

  private ensureCore(): HubCore {
    if (!this.core) {
      const options: HubCoreOptions = { repoId: this.ctx.id.name ?? "repo" };
      this.core = new HubCore(options);
    }
    return this.core;
  }

  private async loadManifest(): Promise<void> {
    const core = this.ensureCore();
    const stored = await this.ctx.storage.get<Record<string, ManifestEntry>>(MANIFEST_KEY);
    if (stored) core.hydrate(stored);
  }

  private async persistManifest(): Promise<void> {
    const core = this.ensureCore();
    await this.ctx.storage.put(MANIFEST_KEY, core.manifestEntries());
  }

  private blobReader(): BlobReader {
    const bucket = this.env.BLOBS;
    return async (hash: string) => {
      if (!bucket) return null;
      const obj = await bucket.get(hash);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    };
  }

  /** Send the full manifest to one connection on connect or resync. */
  private sendManifest(connection: { send(msg: string): void }): void {
    const core = this.ensureCore();
    connection.send(JSON.stringify({ type: "manifest", entries: core.manifestEntries() }));
  }

  private broadcastPresence(): void {
    const actors = [...this.getConnections<ConnectionState>()].map((c) => {
      const state = c.state ?? { actorId: "unknown", displayName: "unknown", kind: "human" };
      return { actorId: state.actorId, displayName: state.displayName, kind: state.kind };
    });
    this.broadcast(JSON.stringify({ type: "presence", actors }));
  }

  override onConnect(
    connection: Parameters<Agent["onConnect"]>[0],
    ctx: { request: Request },
  ): void {
    const url = new URL(ctx.request.url);
    const state: ConnectionState = {
      actorId: url.searchParams.get("actorId") ?? `anon-${connection.id.slice(0, 6)}`,
      displayName: url.searchParams.get("displayName") ?? "anonymous",
      kind: (url.searchParams.get("kind") as ConnectionState["kind"]) ?? "human",
    };
    connection.setState(state);
    this.sendManifest(connection);
    this.broadcastPresence();
  }

  override async onMessage(
    connection: Parameters<Agent["onConnect"]>[0],
    message: unknown,
  ): Promise<void> {
    const raw =
      typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      connection.send(JSON.stringify({ type: "error", code: "bad_json", message: "invalid JSON" }));
      return;
    }

    const result = parseClientMessageSafe(parsed);
    if (!result.ok) {
      connection.send(
        JSON.stringify({ type: "error", code: "bad_message", message: result.error }),
      );
      return;
    }

    const msg = result.value;
    if (msg.type === "hello") {
      this.sendManifest(connection);
      this.broadcastPresence();
      return;
    }
    if (msg.type === "ack") {
      // Client acknowledged a change id; nothing more to do here today.
      return;
    }
    if (msg.type === "change") {
      await this.handleChange(connection, msg, result.raw);
    }
  }

  private async handleChange(
    connection: Parameters<Agent["onConnect"]>[0],
    msg: {
      id: string;
      path: string;
      baseHash: string | null;
      newHash?: string | null;
      contentBase64?: string;
    },
    _raw: unknown,
  ): Promise<void> {
    const core = this.ensureCore();
    const state = connection.state as ConnectionState | null;
    const actorId = state?.actorId ?? "unknown";

    // Inline content: store it as a blob first (small-file path, ADR-020).
    let newHash = msg.newHash ?? null;
    if (msg.contentBase64 !== undefined) {
      newHash = await this.storeInline(msg.contentBase64);
    }

    const change: Change = {
      id: msg.id,
      repoId: this.ctx.id.name ?? "repo",
      actorId,
      path: msg.path,
      baseHash: msg.baseHash,
      newHash,
      ts: Date.now(),
    };

    const result = await core.apply(change, this.blobReader());

    if (result.status === "duplicate") {
      connection.send(JSON.stringify({ type: "ack", changeId: change.id }));
      return;
    }

    if (result.status === "accepted") {
      // Persist merged content if the 3-way merge produced it.
      if (result.mergedContent) {
        const hash = result.entry?.blobHash;
        if (hash) await this.env.BLOBS?.put(hash, result.mergedContent);
      }
      await this.persistManifest();
      this.broadcast(
        JSON.stringify({
          type: "changed",
          path: change.path,
          newHash: result.entry?.blobHash ?? null,
          version: result.entry?.version ?? 0,
          by: actorId,
        }),
      );
      this.noteChangeForCheckpoint();
      return;
    }

    // Conflict: surface it (ADR-005). The merging agent will resolve it later.
    connection.send(
      JSON.stringify({
        type: "conflict",
        changeId: change.id,
        path: change.path,
      }),
    );
    this.broadcast(JSON.stringify({ type: "conflict", changeId: change.id, path: change.path }));
  }

  /**
   * Mark a change as pending a checkpoint and make sure an alarm is set for the
   * next due time (ADR-006). Called after every accepted change.
   */
  private noteChangeForCheckpoint(): void {
    this.checkpoints.onChange(Date.now());
    const next = this.checkpoints.nextCheckAt();
    if (next !== null) {
      // Arm the alarm. Setting it again simply moves it; the alarm handler
      // re-arms if changes keep arriving before the ceiling.
      void this.ctx.storage.setAlarm(next);
    }
  }

  /** Agent alarm hook: commit when the scheduler says a checkpoint is due. */
  override async alarm(): Promise<void> {
    await super.alarm();
    await this.maybeCheckpoint();
  }

  /** Commit to durable history if the scheduler says it is due. */
  private async maybeCheckpoint(): Promise<void> {
    if (!this.env.REPO_STORE) return; // no durable store configured
    const decision = this.checkpoints.due(Date.now());
    if (!decision) return;

    const core = this.ensureCore();
    await runCheckpoint(this.env.REPO_STORE, {
      repo: STORE_REPO,
      entries: core.manifestEntries(),
      readBlob: this.blobReader(),
      message: `checkpoint (${decision.reason})`,
    });
    this.checkpoints.onCommitted();
  }

  /** Public method: force a checkpoint now (manual trigger, ADR-006). */
  async checkpoint(): Promise<{ committed: boolean }> {
    if (!this.env.REPO_STORE) return { committed: false };
    const forced = this.checkpoints.force();
    if (!forced) return { committed: false };
    const core = this.ensureCore();
    await runCheckpoint(this.env.REPO_STORE, {
      repo: STORE_REPO,
      entries: core.manifestEntries(),
      readBlob: this.blobReader(),
      message: "checkpoint (manual)",
    });
    this.checkpoints.onCommitted();
    return { committed: true };
  }

  private async storeInline(base64: string): Promise<string> {
    const bytes = base64ToBytes(base64);
    const hash = await sha256HexBytes(bytes);
    await this.env.BLOBS?.put(hash, bytes);
    return hash;
  }
}

// ---------------------------------------------------------------------------
// Helpers (kept local so the Hub has no extra dependencies)
// ---------------------------------------------------------------------------

function parseClientMessageSafe(
  raw: unknown,
):
  | { ok: true; value: ReturnType<typeof parseClientMessage>; raw: unknown }
  | { ok: false; error: string } {
  try {
    return { ok: true, value: parseClientMessage(raw), raw };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid message" };
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
