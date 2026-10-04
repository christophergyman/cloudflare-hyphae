/**
 * @hyphae/merge-agent: the verified merging agent (ADR-014).
 *
 * Resolves conflicts git cannot, verifies by running tests, and keeps both
 * sides whenever it is not certain. Pure and injected, so it is unit-testable.
 */

export type {
  ConflictInput,
  MergeAgentConfig,
  MergeAgentDeps,
  MergeModel,
  MergeOutcome,
  ModelResolution,
  SandboxVerifier,
  VerifyResult,
} from "./agent.ts";
export { defaultConflictMarkers, MergeAgent } from "./agent.ts";
export type { DetectionInput, DetectionResult } from "./detect.ts";
export { detectTestCommand } from "./detect.ts";
export type { AiBindingLike, OpenAiMergeModelOptions } from "./model.ts";
export {
  buildMergePrompt,
  createAiMergeModel,
  DEFAULT_MERGE_MODEL,
  extractText,
  MERGE_SYSTEM_PROMPT,
  stripFences,
} from "./model.ts";
export type { CreateMergeRunnerOptions, MergeJob, MergeJobResult, SandboxLike } from "./runner.ts";
export { createMergeRunner } from "./runner.ts";
