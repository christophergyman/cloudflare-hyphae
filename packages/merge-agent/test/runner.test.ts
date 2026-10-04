import { describe, expect, it } from "bun:test";
import { createMergeRunner } from "../src/runner.ts";

/**
 * Runner wiring/adapter tests. The decision matrix itself lives once in
 * `decisions.test.ts`; this file covers the runner-specific plumbing: the
 * no-sandbox guard, both model response shapes, and fence stripping.
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
  it("keeps both and stays unverified when no sandbox is configured", async () => {
    const runner = createMergeRunner({
      ai: { run: async () => ({ response: "UNVERIFIED" }) },
    });
    const out = await runner.run(job);
    expect(out.status).toBe("kept-both");
    expect(out.verified).toBeUndefined();
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
