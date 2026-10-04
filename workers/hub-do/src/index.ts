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
import { sha256Hex } from "@hyphae/core";
import type { AiBindingLike } from "@hyphae/merge-agent";
import { createMergeRunner } from "@hyphae/merge-agent";
import type { HistoryEvent, HubRpc } from "@hyphae/protocol";
import type { ArtifactsLike, R2BucketLike, RepoStore } from "@hyphae/repostore";
import { ArtifactsRepoStore } from "@hyphae/repostore";
import { Agent } from "agents";
import { CheckpointScheduler } from "./checkpoint.ts";
import { runCheckpoint } from "./checkpoint-runner.ts";
import { type ApplyResult, type BlobReader, HubCore, type HubCoreOptions } from "./core.ts";
import { base64ToBytes, isAlreadyExistsError, parseClientMessageSafe } from "./helpers.ts";
import { HistoryFeed } from "./history.ts";

export interface HubEnv {
  /** Content-addressed blob store (ADR-004). */
  BLOBS?: R2BucketLike;
  /**
   * Durable history. Left optional so the Hub runs (live-only) without
   * Artifacts wired up; checkpoints are simply skipped when absent.
   */
  REPO_STORE?: RepoStore;
  /**
   * The Artifacts binding (ADR-018). When present, the Hub builds a
   * {@link RepoStore} from it on first checkpoint, so durable history works
   * with no extra wiring.
   */
  ARTIFACTS?: ArtifactsLike;
  /**
   * Runs a conflict job (the verified merge Workflow, ADR-014). Optional: when
   * absent, conflicts are simply surfaced and resolved by a human.
   */
  MERGE?: MergeRunner;
  /** Workers AI binding, used to build a merge runner when MERGE is absent. */
  AI?: AiBindingLike;
  /** Model name for the AI merge. */
  MODEL?: string;
  /** Optional per-repo test command for verification. */
  TEST_COMMAND?: string;
  /**
   * Artifacts repo name used for this Hub's checkpoints. Defaults to "main".
   * This is the repo, not the branch; the git ref stays "heads/main".
   */
  STORE_REPO?: string;
}

/**
 * Runs a conflict through the merging agent and returns the outcome. In
 * production this is a Workflow; for tests it can be a direct call.
 */
export interface MergeRunner {
  run(job: { repoId: string; path: string; base: string; ours: string; theirs: string }): Promise<{
    status: "merged" | "kept-both";
    content?: string;
    reason?: string;
    /** True when the result was verified by running tests (ADR-014). */
    verified?: boolean;
  }>;
}

/** Per-connection state, persisted with the hibernating WebSocket. */
export interface ConnectionState {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  /** A read-only participant (the live view); does not count as an editor. */
  observer?: boolean;
}

const MANIFEST_KEY = "manifest";

export class Hub extends Agent<HubEnv, Record<string, never>> implements HubRpc {
  private core: HubCore | null = null;
  private readonly checkpoints = new CheckpointScheduler();
  private readonly history: HistoryFeed;
  /** Built lazily from the Artifacts binding (ADR-018). */
  private artifactsStore: RepoStore | null = null;

  constructor(ctx: ConstructorParameters<typeof Agent>[0], env: HubEnv) {
    super(ctx, env);
    this.history = new HistoryFeed(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await this.loadManifest();
      await this.history.load();
    });
  }

  /**
   * The Artifacts repo name for checkpoints. Configurable via `env.STORE_REPO`;
   * defaults to "main". The git ref ("heads/main") is the branch and is fixed.
   */
  private get storeRepo(): string {
    return this.env.STORE_REPO ?? "main";
  }

  /**
   * The durable store for checkpoints. Uses an explicit `REPO_STORE` if given,
   * otherwise builds an Artifacts-backed store from the `ARTIFACTS` binding.
   * Returns null when neither is available, so the Hub still runs live-only.
   */
  private repoStore(): RepoStore | null {
    if (this.env.REPO_STORE) return this.env.REPO_STORE;
    if (this.env.ARTIFACTS) {
      if (!this.artifactsStore) {
        this.artifactsStore = new ArtifactsRepoStore(this.env.ARTIFACTS, {
          username: "x",
          tokenTtlSeconds: 3600,
        });
      }
      return this.artifactsStore;
    }
    return null;
  }

  /**
   * Ensure the Artifacts repo exists before the first commit.
   *
   * Checks for the repo first so the normal case does not rely on an error.
   * If creation fails because another call raced us, that is fine; any other
   * failure propagates, so a misconfigured binding is not silently ignored.
   */
  private async ensureRepo(repo: string, store: RepoStore): Promise<void> {
    try {
      if ((await store.readRef(repo, "heads/main")) !== null) return;
    } catch {
      // The repo may not exist yet, or a transient read failed. Fall through and
      // let create decide; a real failure will surface below.
    }
    try {
      await store.createRepo(repo);
    } catch (err) {
      if (isAlreadyExistsError(err)) return;
      throw err;
    }
  }

  /**
   * The merge runner. Uses an explicit `MERGE` binding if given, otherwise
   * builds one from the Workers AI binding through the shared merge-agent
   * wiring. Returns null when neither is available, so conflicts are simply
   * surfaced (never lost).
   *
   * No sandbox is configured here, so the agent refuses to verify and keeps
   * both sides rather than accepting unverified model output (ADR-014). The
   * merge is still attempted: a confident, clean model result is surfaced as
   * "resolved by agent" (unverified), never as "verified".
   */
  private mergeRunner(): MergeRunner | null {
    if (this.env.MERGE) return this.env.MERGE;
    const ai = this.env.AI;
    if (!ai) return null;
    return createMergeRunner({
      ai,
      model: this.env.MODEL,
      testCommand: this.env.TEST_COMMAND,
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
      return {
        actorId: state.actorId,
        displayName: state.displayName,
        kind: state.kind,
        observer: state.observer ?? false,
      };
    });
    this.broadcast(JSON.stringify({ type: "presence", actors }));
  }

  override onConnect(
    connection: Parameters<Agent["onConnect"]>[0],
    ctx: { request: Request },
  ): void {
    const url = new URL(ctx.request.url);
    const kindParam = url.searchParams.get("kind");
    const state: ConnectionState = {
      actorId: (url.searchParams.get("actorId") ?? `anon-${connection.id.slice(0, 6)}`).slice(
        0,
        128,
      ),
      displayName: (url.searchParams.get("displayName") ?? "anonymous").slice(0, 128),
      // Only accept the two known kinds. Anything else is coerced to "human"
      // so a crafted value cannot reach the live view (stored-XSS guard).
      kind: kindParam === "agent" ? "agent" : "human",
      observer: url.searchParams.get("observer") === "1",
    };
    connection.setState(state);
    this.sendManifest(connection);
    if (this.history.size > 0) {
      connection.send(JSON.stringify({ type: "history", events: this.history.snapshot() }));
    }
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
      await this.handleChange(connection, msg);
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
      await this.history.record({
        kind: result.mergedContent ? "merge" : "change",
        path: change.path,
        by: actorId,
        detail: result.mergedContent ? "merged cleanly" : undefined,
        version: result.entry?.version,
        at: Date.now(),
      });
      this.broadcast(
        JSON.stringify({
          type: "changed",
          path: change.path,
          newHash: result.entry?.blobHash ?? null,
          version: result.entry?.version ?? 0,
          by: actorId,
        }),
      );
      await this.noteChangeForCheckpoint();
      return;
    }

    // Conflict: surface it, then try the verified merging agent (ADR-005, ADR-014).
    await this.history.record({
      kind: "conflict",
      path: change.path,
      by: actorId,
      at: Date.now(),
    });
    connection.send(
      JSON.stringify({
        type: "conflict",
        changeId: change.id,
        path: change.path,
      }),
    );
    this.broadcast(JSON.stringify({ type: "conflict", changeId: change.id, path: change.path }));

    await this.tryResolveConflict(change, result);
  }

  /**
   * Ask the merging agent to resolve a conflict. On a verified merge, accept
   * and broadcast it. On keep-both (or no agent configured), leave the conflict
   * surfaced; nothing is ever discarded.
   */
  private async tryResolveConflict(change: Change, result: ApplyResult): Promise<void> {
    if (!result.conflict) return;
    const merge = this.mergeRunner();
    if (!merge) return;

    const read = this.blobReader();
    const baseBytes = result.conflict.baseHash ? await read(result.conflict.baseHash) : null;
    const oursBytes = result.conflict.oursHash ? await read(result.conflict.oursHash) : null;
    const theirsBytes = result.conflict.theirsHash ? await read(result.conflict.theirsHash) : null;
    if (oursBytes === null || theirsBytes === null) return;

    const decode = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : "");

    let outcome: {
      status: "merged" | "kept-both";
      content?: string;
      reason?: string;
      verified?: boolean;
    };
    try {
      outcome = await merge.run({
        repoId: this.ctx.id.name ?? "repo",
        path: change.path,
        base: decode(baseBytes),
        ours: decode(oursBytes),
        theirs: decode(theirsBytes),
      });
    } catch (err) {
      // Surface the failure instead of swallowing it, so the live view shows why.
      await this.history.record({
        kind: "conflict",
        path: change.path,
        by: "merging-agent",
        detail: `merge failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
        at: Date.now(),
      });
      return;
    }

    if (outcome.status !== "merged" || outcome.content === undefined) {
      // Keep both: the conflict stays surfaced for a human. Nothing is lost.
      await this.history.record({
        kind: "conflict",
        path: change.path,
        by: "merging-agent",
        detail: `kept both: ${outcome.reason ?? "unresolved"}`.slice(0, 200),
        at: Date.now(),
      });
      return;
    }

    const bytes = new TextEncoder().encode(outcome.content);
    const hash = await sha256Hex(bytes);
    await this.env.BLOBS?.put(hash, bytes);

    const core = this.ensureCore();
    const entry = core.applyResolution(
      change.path,
      hash,
      result.conflict.theirsHash,
      "merging-agent",
      Date.now(),
    );
    // If the resolution was stale (the file moved on), do not broadcast it.
    if (entry?.blobHash !== hash) return;
    await this.persistManifest();
    await this.history.record({
      kind: "resolved",
      path: change.path,
      by: "merging-agent",
      detail: outcome.verified ? "resolved and verified" : "resolved by agent",
      at: Date.now(),
    });
    this.broadcast(
      JSON.stringify({
        type: "resolved",
        changeId: change.id,
        path: change.path,
        newHash: entry?.blobHash ?? hash,
      }),
    );
    await this.noteChangeForCheckpoint();
  }

  /**
   * Mark a change as pending a checkpoint and make sure an alarm is set for the
   * next due time (ADR-006). Called after every accepted change.
   */
  private async noteChangeForCheckpoint(): Promise<void> {
    this.checkpoints.onChange(Date.now());
    await this.armCheckpointAlarm();
  }

  /**
   * Arm the alarm for the next due checkpoint, if any. Setting it again simply
   * moves it. Surface a failure rather than dropping it: a lost alarm means
   * changes never become durable.
   */
  private async armCheckpointAlarm(): Promise<void> {
    const next = this.checkpoints.nextCheckAt();
    if (next === null) return;
    try {
      await this.ctx.storage.setAlarm(next);
    } catch (err) {
      await this.history.record({
        kind: "change",
        by: "hub",
        detail: `alarm failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
        at: Date.now(),
      });
    }
  }

  /** Agent alarm hook: commit when the scheduler says a checkpoint is due. */
  override async alarm(): Promise<void> {
    await super.alarm();
    await this.maybeCheckpoint();
    await this.armCheckpointAlarm();
  }

  /** Commit to durable history if the scheduler says it is due. */
  private async maybeCheckpoint(): Promise<void> {
    const decision = this.checkpoints.due(Date.now());
    if (!decision) return;
    await this.commitCheckpoint(`checkpoint (${decision.reason})`);
  }

  /** Public method: force a checkpoint now (manual trigger, ADR-006). */
  async checkpoint(): Promise<{ committed: boolean }> {
    return this.commitCheckpoint("checkpoint (manual)");
  }

  /**
   * Commit the current manifest to durable history. If some content cannot be
   * read the commit is incomplete, so the scheduler stays pending to retry.
   */
  private async commitCheckpoint(message: string): Promise<{ committed: boolean }> {
    const store = this.repoStore();
    if (!store) return { committed: false };
    const generation = this.checkpoints.generation;
    const core = this.ensureCore();
    await this.ensureRepo(this.storeRepo, store);
    const result = await runCheckpoint(store, {
      repo: this.storeRepo,
      entries: core.manifestEntries(),
      readBlob: this.blobReader(),
      message,
    });
    if (result.missing.length === 0) this.checkpoints.onCommitted(generation);
    return { committed: result.missing.length === 0 };
  }

  /** Public method: current manifest, for read clients (the live view). */
  manifest(): { entries: Record<string, ManifestEntry> } {
    return { entries: this.ensureCore().manifestEntries() };
  }

  /** Public method: recent activity feed, for read clients (the live view). */
  recentEvents(): { events: HistoryEvent[] } {
    return { events: this.history.snapshot() };
  }

  private async storeInline(base64: string): Promise<string> {
    const bytes = base64ToBytes(base64);
    const hash = await sha256Hex(bytes);
    await this.env.BLOBS?.put(hash, bytes);
    return hash;
  }
}
