import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@hyphae/core";
import { ChangeDetector } from "../src/detector.ts";

const enc = new TextEncoder();

function detector(files: Map<string, Uint8Array>, synced = new Map<string, string>()) {
  return new ChangeDetector(synced, {
    debounceMs: 1,
    hash: (b) => sha256Hex(b),
    read: async (p) => files.get(p) ?? null,
  });
}

describe("ChangeDetector", () => {
  it("emits an add for a brand new file", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("a.txt", enc.encode("hello"));
    const d = detector(files);
    const seen: string[] = [];
    d.onChanges((changes) => seen.push(...changes.map((c) => `${c.kind}:${c.path}`)));
    d.event("a.txt");
    await d.flush();
    expect(seen).toEqual(["add:a.txt"]);
  });

  it("ignores a touch that does not change content", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("a.txt", enc.encode("same"));
    const hash = await sha256Hex(enc.encode("same"));
    const synced = new Map([["a.txt", hash]]);
    const d = detector(files, synced);
    const seen: string[] = [];
    d.onChanges((changes) => seen.push(...changes.map((c) => c.path)));
    d.event("a.txt");
    await d.flush();
    expect(seen).toEqual([]);
  });

  it("emits an update when content changes", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("a.txt", enc.encode("before"));
    const synced = new Map([["a.txt", await sha256Hex(enc.encode("before"))]]);
    const d = detector(files, synced);
    const kinds: string[] = [];
    d.onChanges((changes) => kinds.push(...changes.map((c) => c.kind)));
    files.set("a.txt", enc.encode("after"));
    d.event("a.txt");
    await d.flush();
    expect(kinds).toEqual(["update"]);
  });

  it("emits a delete when a synced file disappears", async () => {
    const files = new Map<string, Uint8Array>();
    const synced = new Map([["a.txt", await sha256Hex(enc.encode("bye"))]]);
    const d = detector(files, synced);
    const kinds: string[] = [];
    d.onChanges((changes) => kinds.push(...changes.map((c) => c.kind)));
    d.event("a.txt");
    await d.flush();
    expect(kinds).toEqual(["delete"]);
  });

  it("suppresses writes the client made itself (echo)", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("a.txt", enc.encode("remote-content"));
    const hash = await sha256Hex(enc.encode("remote-content"));
    const d = detector(files);
    d.noteOwnWrite(hash);
    const seen: string[] = [];
    d.onChanges((changes) => seen.push(...changes.map((c) => c.path)));
    d.event("a.txt");
    await d.flush();
    expect(seen).toEqual([]);
  });

  it("coalesces repeated events for the same path", async () => {
    const files = new Map<string, Uint8Array>();
    files.set("a.txt", enc.encode("v1"));
    const d = detector(files);
    let flushes = 0;
    d.onChanges(() => flushes++);
    d.event("a.txt");
    d.event("a.txt");
    d.event("a.txt");
    await d.flush();
    expect(flushes).toBe(1);
  });
});
