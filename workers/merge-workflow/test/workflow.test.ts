import { describe, expect, it } from "bun:test";
import {
  buildMergePrompt,
  type MergeWorkflowEnv,
  runConflictJob,
  type SandboxLike,
} from "../src/index.ts";

/**
 * One wiring test proving `runConflictJob` drives the shared runner end to end
 * and maps its outcome. The full decision matrix lives once in
 * `packages/merge-agent/test/decisions.test.ts`.
 */

function fakeSandbox(green: boolean): SandboxLike {
  const files = new Map<string, string>();
  return {
    async writeFile(path, content) {
      files.set(path, content);
    },
    async exec() {
      return green
        ? { exitCode: 0, stdout: "all tests pass", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "1 test failed" };
    },
  };
}

describe("runConflictJob", () => {
  it("accepts a model merge that passes tests", async () => {
    const env: MergeWorkflowEnv = {
      AI: {
        async run() {
          return { response: "a\nMERGED\nc\n" };
        },
      },
      Sandbox: fakeSandbox(true),
      TEST_COMMAND: "bun test",
    };
    const out = await runConflictJob(env, {
      repoId: "r",
      path: "f.txt",
      base: "a\nb\nc\n",
      ours: "a\nOURS\nc\n",
      theirs: "a\nTHEIRS\nc\n",
    });
    expect(out.status).toBe("merged");
    expect(out.path).toBe("f.txt");
    expect(out.content).toBe("a\nMERGED\nc\n");
  });
});

describe("buildMergePrompt", () => {
  it("includes base, ours, and theirs", () => {
    const p = buildMergePrompt({ base: "BASE", ours: "OURS", theirs: "THEIRS" });
    expect(p).toContain("BASE");
    expect(p).toContain("OURS");
    expect(p).toContain("THEIRS");
  });
});
