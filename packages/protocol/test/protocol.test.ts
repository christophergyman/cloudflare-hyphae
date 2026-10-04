import { describe, expect, it } from "bun:test";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseHubMessage,
  safeParseHubMessage,
} from "../src/index.ts";

describe("protocol", () => {
  it("exposes a version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("parses a hello", () => {
    const msg = parseClientMessage({
      type: "hello",
      actorId: "actor-1",
      repoId: "repo-1",
    });
    expect(msg.type).toBe("hello");
  });

  it("parses a by-reference change", () => {
    const msg = parseClientMessage({
      type: "change",
      id: "c1",
      path: "src/a.ts",
      baseHash: null,
      newHash: "abc123",
    });
    expect(msg.type).toBe("change");
  });

  it("parses an inline change", () => {
    const msg = parseClientMessage({
      type: "change",
      id: "c2",
      path: "README.md",
      baseHash: "abc",
      contentBase64: "aGVsbG8=",
    });
    expect(msg.type).toBe("change");
  });

  it("rejects a change with neither newHash nor content", () => {
    const result = parseClientMessageSafe({
      type: "change",
      id: "c3",
      path: "x",
      baseHash: null,
    });
    expect(result).toBe(false);
  });

  it("parses a hub changed message", () => {
    const msg = parseHubMessage({
      type: "changed",
      path: "a.ts",
      newHash: "h",
      version: 3,
      by: "actor-1",
    });
    expect(msg.type).toBe("changed");
  });

  it("rejects malformed hub messages", () => {
    expect(safeParseHubMessage({ type: "nope" }).success).toBe(false);
  });
});

function parseClientMessageSafe(raw: unknown): boolean {
  try {
    parseClientMessage(raw);
    return true;
  } catch {
    return false;
  }
}
