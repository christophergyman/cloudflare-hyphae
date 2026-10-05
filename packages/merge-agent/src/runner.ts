/**
 * The shared merge runner wiring (ADR-014).
 *
 * Both the Hub's inline path and the merge Workflow build their conflict
 * resolution through {@link createMergeRunner}, so there is one prompt, one
 * model adapter, one verifier, and one decision path. The Hub injects a
 * no-sandbox verifier (which keeps both sides, honestly unverified); the
 * Workflow injects a Sandbox.
 */

import type { ConflictInput, MergeModel, SandboxVerifier } from "./agent.ts";
import { defaultConflictMarkers, MergeAgent } from "./agent.ts";
import { type AiBindingLike, createAiMergeModel, DEFAULT_MERGE_MODEL } from "./model.ts";

/** A job to resolve. Mirrors the Hub's `MergeRunner` request shape. */
export interface MergeJob {
  repoId: string;
  path: string;
  base: string;
  ours: string;
  theirs: string;
}

/** The outcome the Hub consumes. */
export interface MergeJobResult {
  status: "merged" | "kept-both";
  content?: string;
  reason?: string;
  /** True only when tests ran and passed. */
  verified?: boolean;
}

/** Minimal structural view of a Sandbox binding. */
export interface SandboxLike {
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface CreateMergeRunnerOptions {
  /** AI binding used to build the model. Absent means the model abstains. */
  ai?: AiBindingLike;
  /** Sandbox used to verify. Absent means every merge is unverified. */
  sandbox?: SandboxLike;
  /** Model name; defaults to {@link DEFAULT_MERGE_MODEL}. */
  model?: string;
  /**
   * AI Gateway id to route model calls through (ADR-021). Optional; when
   * absent the model calls Workers AI directly.
   */
  gateway?: string;
  /** Explicit test command override. */
  testCommand?: string;
}

/**
 * A verifier that never passes. Used when no sandbox is configured: the agent
 * refuses to accept the model output and keeps both sides, which is correct
 * because an unverified merge must never overwrite work (ADR-014).
 */
const noSandboxVerifier: SandboxVerifier = {
  async verify() {
    return { green: false, output: "no sandbox configured" };
  },
};

/** A verifier backed by a Sandbox binding. */
function sandboxVerifier(sandbox: SandboxLike): SandboxVerifier {
  return {
    async verify({ path, files, command }) {
      void path;
      for (const file of files) {
        await sandbox.writeFile(file.path, new TextDecoder().decode(file.content));
      }
      const result = await sandbox.exec(command);
      return {
        green: result.exitCode === 0,
        output: `${result.stdout}\n${result.stderr}`.trim(),
      };
    },
  };
}

/**
 * Build a function that resolves one conflict. The returned shape is exactly
 * the Hub's `MergeRunner.run`.
 */
export function createMergeRunner(options: CreateMergeRunnerOptions) {
  const model: MergeModel = createAiMergeModel({
    ai: options.ai,
    model: options.model ?? DEFAULT_MERGE_MODEL,
    gateway: options.gateway,
  });
  const verifier: SandboxVerifier = options.sandbox
    ? sandboxVerifier(options.sandbox)
    : noSandboxVerifier;
  const agent = new MergeAgent({
    model,
    verifier,
    conflictMarkers: defaultConflictMarkers,
    config: { testCommand: options.testCommand },
  });

  return {
    async run(job: MergeJob): Promise<MergeJobResult> {
      const input: ConflictInput = {
        path: job.path,
        base: job.base,
        ours: job.ours,
        theirs: job.theirs,
      };
      const outcome = await agent.resolve(input);
      if (outcome.status === "merged") {
        return { status: "merged", content: outcome.content, verified: outcome.verified };
      }
      return { status: "kept-both", reason: outcome.reason };
    },
  };
}
