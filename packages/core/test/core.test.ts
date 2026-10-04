import { describe, expect, it } from "bun:test";
import { bytesEqual, sha256Hex, toHex } from "../src/index.ts";

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes bytes the same as the equivalent string", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256Hex(bytes)).toBe(await sha256Hex("hello"));
  });
});

describe("toHex / bytesEqual", () => {
  it("formats bytes as lowercase hex", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("compares byte arrays", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
