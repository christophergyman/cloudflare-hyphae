import { describe, expect, it } from "bun:test";
import { base64ToBytes, isAlreadyExistsError, parseClientMessageSafe } from "../src/helpers.ts";

describe("parseClientMessageSafe", () => {
  it("parses a valid hello", () => {
    const result = parseClientMessageSafe({
      type: "hello",
      actorId: "actor-1",
      repoId: "repo-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe("hello");
  });

  it("parses a valid by-reference change", () => {
    const result = parseClientMessageSafe({
      type: "change",
      id: "c1",
      path: "src/a.ts",
      baseHash: null,
      newHash: "abc123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe("change");
  });

  it("returns ok:false with an error string for an invalid message", () => {
    const result = parseClientMessageSafe({
      type: "change",
      id: "c2",
      path: "src/a.ts",
      baseHash: null,
      // neither newHash nor contentBase64: invalid
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false for a non-object", () => {
    const result = parseClientMessageSafe("not a message");
    expect(result.ok).toBe(false);
  });
});

describe("base64ToBytes", () => {
  it("round-trips bytes through base64", () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const binary = String.fromCharCode(...original);
    const decoded = base64ToBytes(btoa(binary));
    expect(decoded).toEqual(original);
  });

  it("decodes known base64", () => {
    expect(new TextDecoder().decode(base64ToBytes(btoa("hello")))).toBe("hello");
  });
});

describe("isAlreadyExistsError", () => {
  it("is true for status 409", () => {
    expect(isAlreadyExistsError({ status: 409 })).toBe(true);
  });

  it("is false for status 400", () => {
    expect(isAlreadyExistsError({ status: 400 })).toBe(false);
  });

  it("is true for a message saying it already exists", () => {
    expect(isAlreadyExistsError(new Error("repo already exists"))).toBe(true);
  });

  it("is false for an unrelated error", () => {
    expect(isAlreadyExistsError(new Error("network unreachable"))).toBe(false);
  });

  it("is false for non-objects", () => {
    expect(isAlreadyExistsError(null)).toBe(false);
    expect(isAlreadyExistsError("already exists")).toBe(false);
  });
});
