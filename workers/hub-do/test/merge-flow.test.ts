import { describe, expect, it } from "bun:test";
import {
  defaultConflictMarkers,
  MergeAgent,
  type MergeModel,
  type SandboxVerifier,
} from "@hyphae/merge-agent";

/**
 * One wiring test proving the Hub's merge path drives the shared merge agent
 * end to end. The full decision matrix lives once in
 * `packages/merge-agent/test/decisions.test.ts`.
 */

function buildAgent(modelContent: string | null, green: boolean, confidence?: number) {
  const model: MergeModel = {
    resolve: async () => ({ content: modelContent, confidence: confidence ?? 0.9 }),
  };
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
});
