import { describe, expect, it } from "bun:test";
import {
  type ConflictInput,
  defaultConflictMarkers,
  detectTestCommand,
  MergeAgent,
  type MergeModel,
  type SandboxVerifier,
} from "../src/index.ts";

const input: ConflictInput = {
  path: "src/api.ts",
  base: "a\nb\nc\n",
  ours: "a\nOURS\nc\n",
  theirs: "a\nTHEIRS\nc\n",
};

function agent(opts: {
  resolve: MergeModel["resolve"];
  verify: SandboxVerifier["verify"];
  minConfidence?: number;
}) {
  return new MergeAgent({
    model: { resolve: opts.resolve },
    verifier: { verify: opts.verify },
    conflictMarkers: defaultConflictMarkers,
    config: { minConfidence: opts.minConfidence },
  });
}

const green: SandboxVerifier["verify"] = async () => ({ green: true });

describe("MergeAgent", () => {
  it("keeps both when confidence is below the threshold", async () => {
    const a = agent({
      resolve: async () => ({ content: "a\nX\nc\n", confidence: 0.2 }),
      verify: green,
      minConfidence: 0.5,
    });
    const out = await a.resolve(input);
    expect(out.status).toBe("kept-both");
    if (out.status === "kept-both") expect(out.reason).toContain("confidence");
  });

  it("keeps both when the model throws", async () => {
    const a = agent({
      resolve: async () => {
        throw new Error("model unavailable");
      },
      verify: green,
    });
    const out = await a.resolve(input);
    expect(out.status).toBe("kept-both");
    if (out.status === "kept-both") expect(out.reason).toContain("model error");
  });

  it("keeps both when verification throws", async () => {
    const a = agent({
      resolve: async () => ({ content: "a\nX\nc\n", confidence: 0.9 }),
      verify: async () => {
        throw new Error("sandbox crashed");
      },
    });
    const out = await a.resolve(input);
    expect(out.status).toBe("kept-both");
    if (out.status === "kept-both") expect(out.reason).toContain("verification error");
  });

  it("passes the detected test command to the verifier", async () => {
    let seen = "";
    const a = new MergeAgent({
      model: { resolve: async () => ({ content: "ok", confidence: 0.9 }) },
      verifier: {
        verify: async (v) => {
          seen = v.command;
          return { green: true };
        },
      },
      conflictMarkers: defaultConflictMarkers,
      config: { testCommand: "bun test" },
    });
    await a.resolve(input);
    expect(seen).toBe("bun test");
  });
});

describe("defaultConflictMarkers", () => {
  it("renders git-style markers carrying both sides", () => {
    const markers = defaultConflictMarkers(input);
    expect(markers).toContain("<<<<<<< ours");
    expect(markers).toContain("OURS");
    expect(markers).toContain("=======");
    expect(markers).toContain("THEIRS");
    expect(markers).toContain(">>>>>>> theirs");
  });
});

describe("detectTestCommand", () => {
  it("prefers an explicit config", () => {
    expect(detectTestCommand({ configured: "pnpm test", packageJson: "{}" })).toEqual({
      command: "pnpm test",
      source: "config",
    });
  });

  it("uses npm test when package.json has a test script", () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest" } });
    expect(detectTestCommand({ packageJson: pkg })).toEqual({
      command: "npm test",
      source: "package-json",
    });
  });

  it("falls back to build when there is no test script", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc" } });
    expect(detectTestCommand({ packageJson: pkg })).toEqual({
      command: "npm run build",
      source: "package-json",
    });
  });

  it("falls back to npm test for a malformed package.json", () => {
    expect(detectTestCommand({ packageJson: "{not json" })).toEqual({
      command: "npm test",
      source: "fallback",
    });
  });

  it("falls back when nothing is provided", () => {
    expect(detectTestCommand({})).toEqual({ command: "npm test", source: "fallback" });
  });
});

describe("MergeAgent: unsafe model output", () => {
  it("keeps both when the model returns empty content", async () => {
    const a = agent({ resolve: async () => ({ content: "   ", confidence: 0.99 }), verify: green });
    const out = await a.resolve(input);
    expect(out.status).toBe("kept-both");
    if (out.status === "kept-both") expect(out.reason).toContain("empty");
  });

  it("treats a missing confidence as untrustworthy", async () => {
    const a = agent({ resolve: async () => ({ content: "a\nX\nc\n" }), verify: green });
    const out = await a.resolve(input);
    expect(out.status).toBe("kept-both");
  });
});
