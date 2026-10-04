/**
 * The verified merge Workflow package (ADR-014).
 *
 * On a true conflict this resolves the conflict with a code-capable model and
 * verifies the result by running the project's tests in a sandbox, accepting
 * the merge only if green. All decision logic, prompt text, and fence handling
 * live in @hyphae/merge-agent; this package is only the Cloudflare wiring.
 *
 * This module is a thin re-export barrel so callers (and tests) have one entry
 * point. The actual work is in ./runner.ts.
 */

export type {
  AiBindingLike,
  SandboxLike,
} from "@hyphae/merge-agent";
export { buildMergePrompt, MERGE_SYSTEM_PROMPT, stripFences } from "@hyphae/merge-agent";
export type {
  ConflictJob,
  MergeWorkflowEnv,
  MergeWorkflowResult,
  RunnerEnv,
} from "./runner.ts";
export { makeMergeRunner, runConflictJob } from "./runner.ts";
