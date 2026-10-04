/**
 * Checkpoint scheduler (ADR-006).
 *
 * Decides WHEN to commit the Hub's live manifest to durable history
 * (Artifacts). The rules are:
 *   - quiescence: about 30s after the last change
 *   - ceiling:     at most about 5min between commits while changes keep coming
 *   - manual:      an explicit trigger (CLI / REST)
 *
 * The scheduler is pure and time is injected, so it is fully testable without
 * timers. The Hub wires it to Durable Object alarms.
 */

export interface CheckpointConfig {
  /** Commit after this much quiet time with pending changes. */
  quietMs: number;
  /** Force a commit after this much time even if changes keep arriving. */
  ceilingMs: number;
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  quietMs: 30_000,
  ceilingMs: 5 * 60_000,
};

type State =
  | { phase: "idle" }
  | { phase: "pending"; firstChangeAt: number; lastChangeAt: number; generation: number };

export class CheckpointScheduler {
  private state: State = { phase: "idle" };
  private readonly config: CheckpointConfig;

  constructor(config: Partial<CheckpointConfig> = {}) {
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config };
  }

  /** Record that the live state changed. */
  onChange(now: number): void {
    if (this.state.phase === "idle") {
      this.state = { phase: "pending", firstChangeAt: now, lastChangeAt: now, generation: 1 };
    } else {
      this.state.lastChangeAt = now;
      this.state.generation++;
    }
  }

  /**
   * Whether a checkpoint is due now, and why. Returns null when nothing is due.
   */
  due(now: number): { reason: "quiet" | "ceiling" } | null {
    if (this.state.phase !== "pending") return null;
    const quietFor = now - this.state.lastChangeAt;
    if (quietFor >= this.config.quietMs) return { reason: "quiet" };
    const sinceFirst = now - this.state.firstChangeAt;
    if (sinceFirst >= this.config.ceilingMs) return { reason: "ceiling" };
    return null;
  }

  /** The time the next check should run, or null when idle. */
  nextCheckAt(): number | null {
    if (this.state.phase !== "pending") return null;
    return Math.min(
      this.state.lastChangeAt + this.config.quietMs,
      this.state.firstChangeAt + this.config.ceilingMs,
    );
  }

  /**
   * The current generation, captured before a commit starts. Pass it back to
   * `onCommitted` so a change that arrived mid-commit keeps the scheduler
   * pending instead of being marked done (which would stall the checkpoint).
   */
  get generation(): number {
    return this.state.phase === "pending" ? this.state.generation : 0;
  }

  /**
   * Mark a commit as completed. If changes arrived since `generation` was
   * captured, stay pending so the new state is checkpointed too.
   */
  onCommitted(generation?: number): void {
    if (
      generation !== undefined &&
      this.state.phase === "pending" &&
      this.state.generation !== generation
    ) {
      // A change landed during the commit: keep pending, reset the quiet clock.
      this.state.firstChangeAt = this.state.lastChangeAt;
      return;
    }
    this.state = { phase: "idle" };
  }

  /** True when there are un-committed changes waiting. */
  get hasPending(): boolean {
    return this.state.phase === "pending";
  }

  /**
   * Force a checkpoint decision regardless of timing (manual trigger).
   * Returns null when there is nothing pending to commit.
   */
  force(): { reason: "manual" } | null {
    return this.state.phase === "pending" ? { reason: "manual" } : null;
  }
}
