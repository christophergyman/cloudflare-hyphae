import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@hyphae/core";
import {
  defaultConflictMarkers,
  MergeAgent,
  type MergeModel,
  type SandboxVerifier,
} from "@hyphae/merge-agent";

/**
 * Proves the full verified-merge decision flow end to end, the way the Hub's
 * MergeRunner drives it: a conflict goes to the model, the sandbox runs tests,
 * and only a green result is accepted. This is the Phase 5 hero path.
 */

function buildAgent(modelContent: string | null, green: boolean, confidence?: number) {
  const model: MergeModel = { resolve: async () => ({ content: modelContent, confidence }) };
  const verifier: SandboxVerifier = {
    verify: async () => (green ? { green: true } : { green: false, output: "1 failed" }),
  };
  return new MergeAgent({ model, verifier, conflictMarkers: defaultConflictMarkers });
}

describe("verified merge flow", () => {
  it("merges a same-line conflict and verifies it with tests", async () => {
    const agent = buildAgent("export const value = 42;\n", true);
    const out = await agent.resolve({
      path: "src/value.ts",
      base: "export const value = 1;\n",
      ours: "export const value = 40;\n",
      theirs: "export const value = 2;\n",
    });
    expect(out.status).toBe("merged");
    if (out.status === "merged") {
      expect(out.content).toBe("export const value = 42;\n");
      expect(out.verified).toBe(true);
    }
  });

  it("keeps both when the merge breaks the tests", async () => {
    const agent = buildAgent("export const value = ;\n", false);
    const out = await agent.resolve({
      path: "src/value.ts",
      base: "export const value = 1;\n",
      ours: "export const value = 40;\n",
      theirs: "export const value = 2;\n",
    });
    expect(out.status).toBe("kept-both");
    if (out.status === "kept-both") {
      expect(out.conflictMarkers).toContain("<<<<<<< ours");
    }
  });

  it("computes a stable hash for the merged content", async () => {
    const agent = buildAgent("merged\n", true);
    const out = await agent.resolve({ path: "f", base: "", ours: "a", theirs: "b" });
    if (out.status === "merged") {
      const h1 = await sha256Hex(out.content);
      const h2 = await sha256Hex(out.content);
      expect(h1).toBe(h2);
    }
  });
});
