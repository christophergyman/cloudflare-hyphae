import { describe, expect, it } from "bun:test";
import { type MergeWorkflowEnv, makeMergeRunner } from "../src/runner.ts";

/**
 * One wiring test proving the merge Workflow builds and drives the shared
 * runner from its runtime bindings. The full decision matrix lives once in
 * `packages/merge-agent/test/decisions.test.ts`.
 */

function env(over: Partial<MergeWorkflowEnv> = {}): MergeWorkflowEnv {
  return {
    AI: {
      async run() {
        return { response: "merged\n" };
      },
    },
    Sandbox: {
      async writeFile() {},
      async exec() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    TEST_COMMAND: "bun test",
    ...over,
  };
}

describe("makeMergeRunner", () => {
  it("returns a verified merge on green tests", async () => {
    const runner = makeMergeRunner(env());
    const out = await runner.run({ repoId: "r", path: "f", base: "a", ours: "b", theirs: "c" });
    expect(out.status).toBe("merged");
    expect(out.content).toContain("merged");
    expect(out.verified).toBe(true);
  });
});
