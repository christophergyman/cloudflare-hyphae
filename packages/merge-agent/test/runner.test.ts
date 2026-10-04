import { describe, expect, it } from "bun:test";
import { createMergeRunner } from "../src/runner.ts";

/**
 * Tests for the shared merge runner wiring. This is the single path the Hub's
 * inline merge and the merge Workflow both go through, so its behavior is the
 * contract: a green sandbox verifies, no sandbox keeps both, and the model is
 * parsed in both response shapes.
 */

function fakeSandbox(green: boolean) {
  return {
    async writeFile() {},
    async exec() {
      return green
        ? { exitCode: 0, stdout: "ok", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "fail" };
    },
  };
}

const job = { repoId: "r", path: "f.ts", base: "a", ours: "b", theirs: "c" };

describe("createMergeRunner", () => {
  it("returns a verified merge when tests pass", async () => {
    const runner = createMergeRunner({
      ai: { run: async () => ({ response: "merged\n" }) },
      sandbox: fakeSandbox(true),
      testCommand: "bun test",
    });
    const out = await runner.run(job);
    expect(out.status).toBe("merged");
    expect(out.content).toContain("merged");
    expect(out.verified).toBe(true);
  });

  it("keeps both when tests fail", async () => {
    const runner = createMergeRunner({
      ai: { run: async () => ({ response: "merged" }) },
      sandbox: fakeSandbox(false),
      testCommand: "bun test",
    });
    const out = await runner.run(job);
    expect(out.status).toBe("kept-both");
  });

  it("keeps both and stays unverified when no sandbox is configured", async () => {
    const runner = createMergeRunner({
      ai: { run: async () => ({ response: "UNVERIFIED" }) },
    });
    const out = await runner.run(job);
    expect(out.status).toBe("kept-both");
    expect(out.verified).toBeUndefined();
  });

  it("keeps both when no model is configured", async () => {
    const runner = createMergeRunner({ sandbox: fakeSandbox(true) });
    const out = await runner.run(job);
    expect(out.status).toBe("kept-both");
  });

  it("parses the OpenAI-style response shape", async () => {
    const runner = createMergeRunner({
      ai: {
        run: async () => ({ choices: [{ message: { content: "from-choices\n" } }] }),
      },
      sandbox: fakeSandbox(true),
      testCommand: "bun test",
    });
    const out = await runner.run(job);
    expect(out.status).toBe("merged");
    expect(out.content).toBe("from-choices\n");
  });

  it("strips a wrapping code fence", async () => {
    const runner = createMergeRunner({
      ai: { run: async () => ({ response: "```ts\nfenced\n```" }) },
      sandbox: fakeSandbox(true),
      testCommand: "bun test",
    });
    const out = await runner.run(job);
    expect(out.content).toBe("fenced");
  });
});
