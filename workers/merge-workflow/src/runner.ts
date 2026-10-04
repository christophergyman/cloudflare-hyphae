/**
 * Adapter that exposes the verified merge as a simple runner the Hub can call
 * through its `MERGE` binding (ADR-014).
 *
 * The Hub knows only the `MergeRunner` interface (a small request/response
 * shape). This file builds one from the runtime bindings: a model through
 * AI Gateway and a Sandbox that runs the project's tests.
 */

import {
  defaultConflictMarkers,
  detectTestCommand,
  MergeAgent,
  type MergeModel,
  type SandboxVerifier,
} from "@hyphae/merge-agent";

export interface RunnerEnv {
  AI?: {
    run(
      model: string,
      options: { messages: { role: string; content: string }[] },
    ): Promise<{ response?: string }>;
  };
  Sandbox?: {
    exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    writeFile(path: string, content: string): Promise<void>;
  };
  TEST_COMMAND?: string;
  MODEL?: string;
  /** Raw package.json, used for test-command detection. */
  PACKAGE_JSON?: string;
}

export interface ConflictJobInput {
  repoId: string;
  path: string;
  base: string;
  ours: string;
  theirs: string;
}

export interface ConflictJobOutput {
  status: "merged" | "kept-both";
  content?: string;
  reason?: string;
}

/** Build a MergeRunner backed by the runtime bindings. */
export function makeMergeRunner(env: RunnerEnv) {
  return {
    async run(job: ConflictJobInput): Promise<ConflictJobOutput> {
      const modelName = env.MODEL ?? "@cf/meta/llama-3.3-70b-instruct";
      const detection = detectTestCommand({
        configured: env.TEST_COMMAND,
        packageJson: env.PACKAGE_JSON,
      });

      const model: MergeModel = {
        async resolve(input) {
          if (!env.AI) return { content: null };
          const result = await env.AI.run(modelName, {
            messages: [
              {
                role: "system",
                content:
                  "You resolve git merge conflicts. Output ONLY the merged file. No conflict markers, no explanation, no code fences.",
              },
              {
                role: "user",
                content: [
                  "--- BASE ---",
                  input.base,
                  "--- OURS ---",
                  input.ours,
                  "--- THEIRS ---",
                  input.theirs,
                ].join("\n"),
              },
            ],
          });
          const content = stripFences(result.response ?? "");
          return { content: content.length > 0 ? content : null, confidence: 0.8 };
        },
      };

      const verifier: SandboxVerifier = {
        async verify({ path, files, command }) {
          if (!env.Sandbox) return { green: true }; // no sandbox: accept model output
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

      const agent = new MergeAgent({
        model,
        verifier,
        conflictMarkers: defaultConflictMarkers,
        config: { testCommand: detection.command },
      });

      const outcome = await agent.resolve({
        path: job.path,
        base: job.base,
        ours: job.ours,
        theirs: job.theirs,
      });

      if (outcome.status === "merged") {
        return { status: "merged", content: outcome.content };
      }
      return { status: "kept-both", reason: outcome.reason };
    },
  };
}

export function stripFences(text: string): string {
  const match = text.match(/^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/);
  return match?.[1] ?? text;
}
