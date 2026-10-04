/**
 * The verified merge Workflow (ADR-014).
 *
 * On a true conflict, this durable job:
 *   1. asks a code-capable model (through AI Gateway) for a merged file
 *   2. boots a per-merge Sandbox and runs the project's build/tests
 *   3. accepts the merge only if green, otherwise keeps both sides
 *
 * This file is the Cloudflare wiring. The decision logic lives in
 * @hyphae/merge-agent and is unit-tested there. The model and sandbox are
 * injected at runtime through bindings, so this file stays thin.
 */

import type { MergeModel, SandboxVerifier } from "@hyphae/merge-agent";
import { defaultConflictMarkers, detectTestCommand, MergeAgent } from "@hyphae/merge-agent";

export interface MergeWorkflowEnv {
  /** AI Gateway route to a code-capable model. */
  AI?: AiBinding;
  /** Cloudflare Sandbox binding (ctx.container / Sandbox SDK). */
  Sandbox?: SandboxLike;
  /** Optional per-repo test command override. */
  TEST_COMMAND?: string;
  /** Optional model name. */
  MODEL?: string;
}

/** Minimal shape of a Workers AI binding. */
export interface AiBinding {
  run(
    model: string,
    options: { messages: { role: string; content: string }[] },
  ): Promise<{
    response?: string;
  }>;
}

export interface SandboxLike {
  /** Run a shell command in an isolated container; returns exit code + output. */
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Write a file into the sandbox working tree. */
  writeFile(path: string, content: string): Promise<void>;
}

export interface ConflictJob {
  repoId: string;
  path: string;
  base: string;
  ours: string;
  theirs: string;
  /** Full file tree to test against (path -> content). */
  tree?: { path: string; content: string }[];
}

export interface MergeWorkflowResult {
  status: "merged" | "kept-both";
  path: string;
  content?: string;
  reason?: string;
}

/**
 * Build a merge agent from the runtime bindings. Kept as a factory so tests and
 * the Workflow share one construction path.
 */
export function buildMergeAgent(env: MergeWorkflowEnv, modelName: string): MergeAgent {
  const model: MergeModel = {
    async resolve(input) {
      if (!env.AI) return { content: null };
      const prompt = buildPrompt(input);
      const result = await env.AI.run(modelName, {
        messages: [
          {
            role: "system",
            content:
              "You resolve git merge conflicts. Output ONLY the merged file content, with no conflict markers, no explanation, and no code fences.",
          },
          { role: "user", content: prompt },
        ],
      });
      const raw = result.response ?? null;
      // Strip code fences if the model added them, but keep content intact.
      const content = raw === null ? null : stripFences(raw);
      return { content, confidence: content ? 0.8 : 0 };
    },
  };

  const verifier: SandboxVerifier = {
    async verify({ path, files, command }) {
      if (!env.Sandbox) return { green: false, output: "no sandbox configured" };
      for (const file of files) {
        await env.Sandbox.writeFile(file.path, new TextDecoder().decode(file.content));
      }
      void path;
      const result = await env.Sandbox.exec(command);
      return {
        green: result.exitCode === 0,
        output: `${result.stdout}\n${result.stderr}`.trim(),
      };
    },
  };

  return new MergeAgent({
    model,
    verifier,
    conflictMarkers: defaultConflictMarkers,
    config: { testCommand: env.TEST_COMMAND },
  });
}

/** The prompt sent to the model for a conflict. */
export function buildPrompt(input: { base: string; ours: string; theirs: string }): string {
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
 * Remove a ```lang fence if the model wrapped its answer in one, without
 * altering the content otherwise. Models sometimes add fences despite being
 * asked not to; we strip only the fence, never the file's own whitespace.
 */
export function stripFences(text: string): string {
  const leading = text.replace(/^\s*\n/, "");
  const match = leading.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/);
  if (match) return match[1] ?? "";
  return text;
}

/** Run one conflict job end to end (used by the Workflow and by tests). */
export async function runConflictJob(
  env: MergeWorkflowEnv,
  job: ConflictJob,
): Promise<MergeWorkflowResult> {
  const detection = detectTestCommand({ configured: env.TEST_COMMAND });
  const agent = buildMergeAgent(env, env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct");
  const outcome = await agent.resolve({
    path: job.path,
    base: job.base,
    ours: job.ours,
    theirs: job.theirs,
  });

  if (outcome.status === "merged") {
    return { status: "merged", path: job.path, content: outcome.content };
  }
  void detection;
  return { status: "kept-both", path: job.path, reason: outcome.reason };
}
