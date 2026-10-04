/**
 * The verified merge Workflow wiring (ADR-014).
 *
 * This file is the Cloudflare wiring: it builds the shared merge runner from
 * the runtime bindings (AI Gateway + Sandbox) and runs one conflict job. All
 * decision logic, prompt text, and fence handling live in @hyphae/merge-agent,
 * so the Hub's inline path and this Workflow cannot diverge.
 */

import type { AiBindingLike, SandboxLike } from "@hyphae/merge-agent";
import { createMergeRunner, DEFAULT_MERGE_MODEL, detectTestCommand } from "@hyphae/merge-agent";

export interface MergeWorkflowEnv {
  /** AI Gateway route to a code-capable model. */
  AI?: AiBindingLike;
  /** Cloudflare Sandbox binding (ctx.container / Sandbox SDK). */
  Sandbox?: SandboxLike;
  /** Optional per-repo test command override. */
  TEST_COMMAND?: string;
  /** Optional model name. */
  MODEL?: string;
  /** Raw package.json, used for test-command detection. */
  PACKAGE_JSON?: string;
}

export interface ConflictJob {
  repoId: string;
  path: string;
  base: string;
  ours: string;
  theirs: string;
}

export interface MergeWorkflowResult {
  status: "merged" | "kept-both";
  path: string;
  content?: string;
  reason?: string;
}

/** Backwards-compatible alias used by tests and callers. */
export type RunnerEnv = MergeWorkflowEnv;

/**
 * Build a merge runner backed by the runtime bindings. A thin wrapper over the
 * shared {@link createMergeRunner}, resolving the test command once.
 */
export function makeMergeRunner(env: MergeWorkflowEnv) {
  const detection = detectTestCommand({
    configured: env.TEST_COMMAND,
    packageJson: env.PACKAGE_JSON,
  });
  return createMergeRunner({
    ai: env.AI,
    sandbox: env.Sandbox,
    model: env.MODEL ?? DEFAULT_MERGE_MODEL,
    testCommand: detection.command,
  });
}

/**
 * Run one conflict job end to end. Builds the shared runner with a Sandbox
 * verifier when one is configured, otherwise keeps both sides unverified.
 */
export async function runConflictJob(
  env: MergeWorkflowEnv,
  job: ConflictJob,
): Promise<MergeWorkflowResult> {
  const detection = detectTestCommand({
    configured: env.TEST_COMMAND,
    packageJson: env.PACKAGE_JSON,
  });
  const runner = createMergeRunner({
    ai: env.AI,
    sandbox: env.Sandbox,
    model: env.MODEL ?? DEFAULT_MERGE_MODEL,
    testCommand: detection.command,
  });

  const outcome = await runner.run(job);
  if (outcome.status === "merged") {
    return { status: "merged", path: job.path, content: outcome.content };
  }
  return { status: "kept-both", path: job.path, reason: outcome.reason };
}
