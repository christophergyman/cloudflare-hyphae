/**
 * The shared model adapter for the verified merging agent (ADR-014).
 *
 * Every runtime that resolves conflicts (the Hub's inline path and the merge
 * Workflow) builds its {@link MergeModel} through here, so the prompt text,
 * fence stripping, and response parsing live in exactly one place. Divergence
 * between copies previously produced different merged bytes for identical
 * model output, which is a correctness bug, not a cosmetic one.
 */

import type { ConflictInput, MergeModel, ModelResolution } from "./agent.ts";

/** Minimal structural view of the Workers AI binding. */
export interface AiBindingLike {
  run(model: string, options: unknown): Promise<unknown>;
}

/** Default model. A frontier open coding model available on Workers AI. */
export const DEFAULT_MERGE_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** The system prompt: ask for the merged file and nothing else. */
export const MERGE_SYSTEM_PROMPT =
  "You resolve git merge conflicts. Output ONLY the fully merged file content, " +
  "with no conflict markers, no explanation, and no code fences.";

/** Build the user prompt for a conflict. One implementation, so paths agree. */
export function buildMergePrompt(input: Pick<ConflictInput, "base" | "ours" | "theirs">): string {
  return [
    "Resolve this merge conflict.",
    "",
    "--- BASE ---",
    input.base,
    "--- OURS ---",
    input.ours,
    "--- THEIRS ---",
    input.theirs,
    "",
    "Return the fully merged file.",
  ].join("\n");
}

/**
 * Strip a single ```lang fence wrapping the whole answer, if present.
 *
 * Only the fence is removed; the file's own leading/trailing whitespace is
 * preserved. A leading blank line before the fence is tolerated because some
 * models emit one.
 */
export function stripFences(text: string): string {
  const match = text.match(/^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/);
  return match?.[1] ?? text;
}

/**
 * Extract assistant text from a Workers AI response. Handles both the
 * text-generation shape (`{ response }`) and the OpenAI-style shape
 * (`{ choices: [{ message: { content } }] }`) that code models return.
 */
export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as {
      response?: unknown;
      choices?: { message?: { content?: unknown } }[];
    };
    if (typeof r.response === "string") return r.response;
    const content = r.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  }
  return "";
}

export interface OpenAiMergeModelOptions {
  /** The AI binding, or absent to make the model abstain. */
  ai?: AiBindingLike;
  /** Model name; defaults to {@link DEFAULT_MERGE_MODEL}. */
  model?: string;
  /** Confidence to report for a non-empty result. Defaults to 0.8. */
  confidence?: number;
}

/**
 * Build a {@link MergeModel} from an AI binding. When the binding is absent the
 * model abstains, which drives the agent to keep both sides (never discard).
 */
export function createAiMergeModel(options: OpenAiMergeModelOptions): MergeModel {
  const { ai, model = DEFAULT_MERGE_MODEL, confidence = 0.8 } = options;
  return {
    async resolve(input: ConflictInput): Promise<ModelResolution> {
      if (!ai) return { content: null };
      const result = await ai.run(model, {
        messages: [
          { role: "system", content: MERGE_SYSTEM_PROMPT },
          { role: "user", content: buildMergePrompt(input) },
        ],
      });
      const content = stripFences(extractText(result));
      if (content.trim().length === 0) return { content: null };
      return { content, confidence };
    },
  };
}
