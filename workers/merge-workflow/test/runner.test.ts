import { describe, expect, it } from "bun:test";
import { makeMergeRunner, type RunnerEnv } from "../src/runner.ts";

function env(over: Partial<RunnerEnv> = {}): RunnerEnv {
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
  });

  it("keeps both when tests fail", async () => {
    const runner = makeMergeRunner(
      env({
        Sandbox: {
          async writeFile() {},
          async exec() {
            return { exitCode: 1, stdout: "", stderr: "fail" };
          },
        },
      }),
    );
    const out = await runner.run({ repoId: "r", path: "f", base: "a", ours: "b", theirs: "c" });
    expect(out.status).toBe("kept-both");
  });

  it("strips code fences from the model output", async () => {
    const runner = makeMergeRunner(
      env({
        AI: {
          async run() {
            return { response: "```ts\nmerged\n```" };
          },
        },
      }),
    );
    const out = await runner.run({ repoId: "r", path: "f", base: "a", ours: "b", theirs: "c" });
    expect(out.status).toBe("merged");
    expect(out.content).toBe("merged");
  });

  it("keeps both when no model is configured", async () => {
    const runner = makeMergeRunner(env({ AI: undefined }));
    const out = await runner.run({ repoId: "r", path: "f", base: "a", ours: "b", theirs: "c" });
    expect(out.status).toBe("kept-both");
  });
});

describe("makeMergeRunner: no sandbox", () => {
  it("refuses to accept an unverified merge when no sandbox is configured", async () => {
    const runner = makeMergeRunner({
      AI: {
        async run() {
          return { response: "UNVERIFIED" };
        },
      },
    });
    const out = await runner.run({ repoId: "r", path: "f", base: "a", ours: "b", theirs: "c" });
    expect(out.status).toBe("kept-both");
  });
});
