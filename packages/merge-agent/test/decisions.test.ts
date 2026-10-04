import { describe, expect, it } from "bun:test";
import { type AiBindingLike, createMergeRunner, type SandboxLike } from "../src/index.ts";

/**
 * The one merge-decision matrix.
 *
 * The Hub's inline path and the merge Workflow both run through
 * {@link createMergeRunner}, so the four outcomes that matter (merged, abstain,
 * tests-fail, no-model) are pinned here once, at the shared decision path.
 * Per-runtime files keep only a single wiring test proving they call this path.
 */

const job = { repoId: "r", path: "src/f.ts", base: "a\n", ours: "b\n", theirs: "c\n" };

function sandbox(green: boolean): SandboxLike {
  return {
    async writeFile() {},
    async exec() {
      return green
        ? { exitCode: 0, stdout: "ok", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "1 failing test" };
    },
  };
}

const ai = (text: string): AiBindingLike => ({
  run: async () => ({ response: text }),
});

interface DecisionCase {
  name: string;
  ai?: AiBindingLike;
  sandbox?: SandboxLike;
  expected: "merged" | "kept-both";
  content?: string;
  reason?: string;
}

const cases: DecisionCase[] = [
  {
    name: "merged: the model proposes a merge and the tests pass",
    ai: ai("a\nMERGED\n"),
    sandbox: sandbox(true),
    expected: "merged",
    content: "a\nMERGED\n",
  },
  {
    name: "abstain: the model declines, so both sides are kept",
    ai: ai(""),
    sandbox: sandbox(true),
    expected: "kept-both",
    reason: "abstained",
  },
  {
    name: "tests-fail: the model proposes but the tests fail, so both sides are kept",
    ai: ai("a\nBROKEN\n"),
    sandbox: sandbox(false),
    expected: "kept-both",
    reason: "tests failed",
  },
  {
    name: "no-model: no AI is configured, so both sides are kept",
    sandbox: sandbox(true),
    expected: "kept-both",
    reason: "abstained",
  },
];

describe("merge decision matrix (shared runner)", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const runner = createMergeRunner({ ai: c.ai, sandbox: c.sandbox, testCommand: "bun test" });
      const out = await runner.run(job);
      expect(out.status).toBe(c.expected);
      if (c.expected === "merged") {
        expect(out.content).toBe(c.content);
        expect(out.verified).toBe(true);
      } else {
        expect(out.reason).toContain(c.reason ?? "");
      }
    });
  }
});
