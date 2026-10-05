import { describe, expect, it } from "bun:test";
import type { AiBindingLike } from "../src/index.ts";
import { createAiMergeModel } from "../src/model.ts";

/**
 * AI Gateway routing (ADR-021). Proves the gateway is passed as the third
 * Workers AI argument only when configured, so the default two-argument path
 * is unchanged for deployments that do not set a gateway.
 */

const input = { path: "src/f.ts", base: "a\n", ours: "b\n", theirs: "c\n" };

/** Records each `run` call's arguments so the test can assert the arity. */
function recordingAi(): { ai: AiBindingLike; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const ai: AiBindingLike = {
    async run(...args: unknown[]) {
      calls.push(args);
      return { response: "merged" };
    },
  };
  return { ai, calls };
}

describe("createAiMergeModel gateway routing", () => {
  it("passes the gateway as the third run argument when configured", async () => {
    const { ai, calls } = recordingAi();
    const model = createAiMergeModel({ ai, gateway: "my-gateway" });

    const out = await model.resolve(input);

    expect(out.content).toBe("merged");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(calls[0]?.[2]).toEqual({ gateway: { id: "my-gateway" } });
  });

  it("omits the third argument when no gateway is configured", async () => {
    const { ai, calls } = recordingAi();
    const model = createAiMergeModel({ ai });

    await model.resolve(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });
});
