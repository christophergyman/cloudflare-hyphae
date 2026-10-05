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
import type { AiBindingLike } from "@hyphae/merge-agent";
import { createMergeRunner } from "@hyphae/merge-agent";
import type { HistoryEvent, HubRpc } from "@hyphae/protocol";
import type { ArtifactsLike, R2BucketLike, RepoStore } from "@hyphae/repostore";
import { ArtifactsRepoStore } from "@hyphae/repostore";
import { Agent } from "agents";
import { blobReader, storeInline } from "./blobs.ts";
import { CheckpointScheduler, planCheckpointSchedule } from "./checkpoint.ts";
import { runCheckpoint } from "./checkpoint-runner.ts";
import { HubCore, type HubCoreOptions, loadManifestEntries, persistManifestEntry } from "./core.ts";
import { isAlreadyExistsError, parseClientMessageSafe } from "./helpers.ts";
import { HistoryFeed } from "./history.ts";
import type { MergeRunner } from "./merge-coordinator.ts";
import { tryResolveConflict } from "./merge-coordinator.ts";
import { presenceMessage } from "./presence.ts";

export type { MergeRunner } from "./merge-coordinator.ts";

/**
 * Name of the Agent SDK schedule callback that runs the checkpoint. It must
 * match the {@link Hub.onCheckpointDue} method so the SDK's scheduler resolver
 * can find it on the Hub.
 */
const CHECKPOINT_CALLBACK = "onCheckpointDue" as const;

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
  /**
   * AI Gateway id for the merge model (ADR-021). Optional; when absent the
   * model calls Workers AI directly.
   */
  AI_GATEWAY_ID?: string;
  /** Optional per-repo test command for verification. */
  TEST_COMMAND?: string;
  /**
   * Artifacts repo name used for this Hub's checkpoints. Defaults to "main".
   * This is the repo, not the branch; the git ref stays "heads/main".
   */
  STORE_REPO?: string;
}

/**
 * Per-connection state, persisted with the hibernating WebSocket.
 */
export interface ConnectionState {
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
  /** A read-only participant (the live view); does not count as an editor. */
  observer?: boolean;
}

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
      gateway: this.env.AI_GATEWAY_ID,
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
    const stored = await loadManifestEntries(this.ctx.storage);
    if (Object.keys(stored).length > 0) core.hydrate(stored);
  }

  /**
   * Persist a single path's manifest entry (or delete its key on a tombstone).
   * Per-path writes keep each accepted change O(1) in the manifest size instead
   * of rewriting the whole manifest object.
   */
  private async persistManifest(path: string, entry: ManifestEntry | undefined): Promise<void> {
    await persistManifestEntry(this.ctx.storage, path, entry);
  }

  /** Send the full manifest to one connection on connect or resync. */
  private sendManifest(connection: { send(msg: string): void }): void {
    const core = this.ensureCore();
    connection.send(JSON.stringify({ type: "manifest", entries: core.manifestEntries() }));
  }

  private broadcastPresence(): void {
    const states = [...this.getConnections<ConnectionState>()].map((c) => c.state);
    this.broadcast(JSON.stringify(presenceMessage(states)));
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
      newHash = await storeInline(this.env.BLOBS, msg.contentBase64);
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

    const result = await core.apply(change, blobReader(this.env.BLOBS));

    if (result.status === "duplicate") {
      connection.send(JSON.stringify({ type: "ack", changeId: change.id }));
      return;
    }

    if (result.status === "accepted") {
      if (result.mergedContent) {
        const hash = result.entry?.blobHash;
        if (hash) await this.env.BLOBS?.put(hash, result.mergedContent);
      }
      await this.persistManifest(change.path, result.entry);
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

    await tryResolveConflict(
      {
        repoId: this.ctx.id.name ?? "repo",
        core,
        readBlob: blobReader(this.env.BLOBS),
        blobs: this.env.BLOBS,
        mergeRunner: () => this.mergeRunner(),
        history: this.history,
        persistManifest: (path, entry) => this.persistManifest(path, entry),
        broadcast: (msg) => this.broadcast(msg),
        noteChangeForCheckpoint: () => this.noteChangeForCheckpoint(),
      },
      change,
      result,
    );
  }

  /**
   * Mark a change as pending a checkpoint and make sure the Agent SDK has a
   * schedule armed for the next due time (ADR-006). Called after every
   * accepted change.
   */
  private async noteChangeForCheckpoint(): Promise<void> {
    this.checkpoints.onChange(Date.now());
    await this.syncCheckpointSchedule();
  }

  /**
   * Ensure exactly one checkpoint schedule is armed for `nextCheckAt()`.
   *
   * The Agent SDK owns the Durable Object alarm through its `Lifecycle`, so the
   * Hub never calls `ctx.storage.setAlarm` (which would clobber SDK-scheduled
   * work). It uses the SDK scheduler instead:
   *   - `Agent.schedule(when, callback, payload?, options?): Promise<Schedule>`
   *     creates a one-shot schedule at `when`.
   *   - `Agent.listSchedules(criteria?): Promise<Schedule[]>` and
   *     `Agent.cancelSchedule(id): Promise<boolean>` let us remove the previous
   *     arm first, because a one-shot `schedule()` is not idempotent and would
   *     otherwise accumulate stale rows across re-arms and DO evictions.
   * Signatures cited from `agents@0.26.0` (`node_modules/agents/dist`).
   *
   * Surface a failure rather than dropping it: a lost schedule means changes
   * never become durable.
   */
  private async syncCheckpointSchedule(): Promise<void> {
    try {
      const schedules = await this.listSchedules();
      const { cancelIds, armAt } = planCheckpointSchedule({
        nextCheckAt: this.checkpoints.nextCheckAt(),
        schedules,
        callback: CHECKPOINT_CALLBACK,
      });
      for (const id of cancelIds) await this.cancelSchedule(id);
      if (armAt !== null) await this.schedule(new Date(armAt), CHECKPOINT_CALLBACK);
    } catch (err) {
      await this.history.record({
        kind: "change",
        by: "hub",
        detail: `schedule failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
        at: Date.now(),
      });
    }
  }

  /**
   * Agent SDK schedule callback: commit when the scheduler says a checkpoint is
   * due, then re-arm if changes are still pending. Re-arming covers a change
   * that landed while the commit was in flight, and a commit that could not
   * read all content and must be retried.
   *
   * The SDK resolves this name to a method on the Hub and invokes it inside the
   * Lifecycle host boundary (see the `Scheduler` callback resolver in
   * `agents@0.26.0`), so it is the migration of the old `alarm()` hook.
   */
  async onCheckpointDue(): Promise<void> {
    await this.maybeCheckpoint();
    await this.syncCheckpointSchedule();
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
      readBlob: blobReader(this.env.BLOBS),
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
}
