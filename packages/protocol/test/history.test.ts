import { describe, expect, it } from "bun:test";
import { historyEventSchema, historyMessageSchema, parseHubMessage } from "../src/index.ts";

describe("history message", () => {
  it("parses a history message with events", () => {
    const msg = parseHubMessage({
      type: "history",
      events: [
        { kind: "change", path: "a.ts", by: "alice", version: 2, at: 100 },
        { kind: "merge", path: "b.ts", by: "bob", detail: "merged cleanly", at: 101 },
        { kind: "conflict", path: "c.ts", at: 102 },
      ],
    });
    expect(msg.type).toBe("history");
    if (msg.type === "history") {
      expect(msg.events.length).toBe(3);
      expect(msg.events[0]?.kind).toBe("change");
      expect(msg.events[1]?.detail).toBe("merged cleanly");
    }
  });

  it("accepts an empty history", () => {
    const parsed = historyMessageSchema.safeParse({ type: "history", events: [] });
    expect(parsed.success).toBe(true);
  });

  it("rejects an event without a timestamp", () => {
    const parsed = historyEventSchema.safeParse({ kind: "change" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a history message with a malformed event", () => {
    const parsed = historyMessageSchema.safeParse({
      type: "history",
      events: [{ kind: "change", at: "not-a-number" }],
    });
    expect(parsed.success).toBe(false);
  });
});
