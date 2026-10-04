import { describe, expect, it } from "bun:test";
import {
  buildPrompt,
  type MergeWorkflowEnv,
  runConflictJob,
  type SandboxLike,
} from "../src/index.ts";

function envWithModel(answer: string | null): MergeWorkflowEnv {
  return {
    AI: {
      async run() {
        return { response: answer ?? undefined };
      },
    },
    Sandbox: fakeSandbox(true),
    TEST_COMMAND: "bun test",
  };
}

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
    const env = envWithModel("a\nMERGED\nc\n");
    const out = await runConflictJob(env, {
      repoId: "r",
      path: "f.txt",
      base: "a\nb\nc\n",
      ours: "a\nOURS\nc\n",
      theirs: "a\nTHEIRS\nc\n",
    });
    expect(out.status).toBe("merged");
    expect(out.content).toBe("a\nMERGED\nc\n");
  });

  it("keeps both when the model abstains", async () => {
    const env = envWithModel(null);
    const out = await runConflictJob(env, {
      repoId: "r",
      path: "f.txt",
      base: "a\n",
      ours: "a\n",
      theirs: "a\n",
    });
    expect(out.status).toBe("kept-both");
  });

  it("keeps both when tests fail", async () => {
    const env: MergeWorkflowEnv = {
      AI: {
        async run() {
          return { response: "bad merge" };
        },
      },
      Sandbox: fakeSandbox(false),
      TEST_COMMAND: "bun test",
    };
    const out = await runConflictJob(env, {
      repoId: "r",
      path: "f.txt",
      base: "a\n",
      ours: "a\n",
      theirs: "a\n",
    });
    expect(out.status).toBe("kept-both");
    expect(out.reason).toContain("tests failed");
  });

  it("keeps both when no model is configured", async () => {
    const out = await runConflictJob(
      { Sandbox: fakeSandbox(true) },
      { repoId: "r", path: "f.txt", base: "", ours: "a", theirs: "b" },
    );
    expect(out.status).toBe("kept-both");
  });
});

describe("buildPrompt", () => {
  it("includes base, ours, and theirs", () => {
    const p = buildPrompt({ base: "BASE", ours: "OURS", theirs: "THEIRS" });
    expect(p).toContain("BASE");
    expect(p).toContain("OURS");
    expect(p).toContain("THEIRS");
  });
});
