/**
 * The merging agent (ADR-014).
 *
 * Resolves a conflict git cannot, then proves its work: a candidate merge is
 * accepted only if the project's build and tests pass in an isolated sandbox.
 * If the model is unsure, or tests fail, both sides are kept and surfaced.
 * Nothing is ever discarded.
 *
 * Pure and injected (model + verifier are interfaces), so the whole decision
 * flow is unit-testable without Workers AI or a container.
 */

export interface ConflictInput {
  path: string;
  /** The common ancestor's content. */
  base: string;
  /** Our side. */
  ours: string;
  /** Their side. */
  theirs: string;
}

/** Calls a code-capable model to produce a merged file. */
export interface MergeModel {
  resolve(input: ConflictInput): Promise<ModelResolution>;
}

export interface ModelResolution {
  /** The merged file, or null if the model declined/abstained. */
  content: string | null;
  /** Model's own confidence in the result (0..1). Optional. */
  confidence?: number;
}

/** Verifies a candidate by running the project's build and tests. */
export interface SandboxVerifier {
  verify(input: {
    path: string;
    /** The full candidate file tree with the merge applied. */
    files: { path: string; content: Uint8Array }[];
    /** Command to run (from config or detection). */
    command: string;
  }): Promise<VerifyResult>;
}

export interface VerifyResult {
  /** True when build and tests passed. */
  green: boolean;
  /** Captured output, for surfacing on failure. */
  output?: string;
}

export interface MergeAgentConfig {
  /** Reject a model result below this confidence without verification. */
  minConfidence?: number;
  /** Command to run for verification. */
  testCommand?: string;
}

export type MergeOutcome =
  | { status: "merged"; content: string; verified: boolean }
  | { status: "kept-both"; reason: string; conflictMarkers: string };

export interface MergeAgentDeps {
  model: MergeModel;
  verifier: SandboxVerifier;
  /** Produce conflict-marker text for the keep-both fallback. */
  conflictMarkers: (input: ConflictInput) => string;
  config?: MergeAgentConfig;
}

export class MergeAgent {
  constructor(private readonly deps: MergeAgentDeps) {}

  private get minConfidence(): number {
    return this.deps.config?.minConfidence ?? 0.5;
  }

  /**
   * Attempt to resolve a conflict. Order (ADR-005, ADR-014):
   *   1. ask the model
   *   2. if it abstains or is unsure, keep both
   *   3. verify the candidate by running tests
   *   4. commit only if green; otherwise keep both
   */
  async resolve(input: ConflictInput): Promise<MergeOutcome> {
    let resolution: ModelResolution;
    try {
      resolution = await this.deps.model.resolve(input);
    } catch (err) {
      return this.keepBoth(input, `model error: ${describe(err)}`);
    }

    if (resolution.content === null || resolution.content === undefined) {
      return this.keepBoth(input, "model abstained");
    }
    if (resolution.confidence !== undefined && resolution.confidence < this.minConfidence) {
      return this.keepBoth(input, `model confidence ${resolution.confidence} below threshold`);
    }

    let verified: VerifyResult;
    try {
      verified = await this.deps.verifier.verify({
        path: input.path,
        files: [{ path: input.path, content: new TextEncoder().encode(resolution.content) }],
        command: this.deps.config?.testCommand ?? "npm test",
      });
    } catch (err) {
      return this.keepBoth(input, `verification error: ${describe(err)}`);
    }

    if (!verified.green) {
      return this.keepBoth(input, `tests failed: ${verified.output ?? "no output"}`);
    }

    return { status: "merged", content: resolution.content, verified: true };
  }

  private keepBoth(input: ConflictInput, reason: string): MergeOutcome {
    return {
      status: "kept-both",
      reason,
      conflictMarkers: this.deps.conflictMarkers(input),
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build standard git-style conflict markers for a keep-both result. */
export function defaultConflictMarkers(input: ConflictInput): string {
  return [
    "<<<<<<< ours",
    input.ours.replace(/\n$/, ""),
    "=======",
    input.theirs.replace(/\n$/, ""),
    ">>>>>>> theirs",
  ].join("\n");
}
