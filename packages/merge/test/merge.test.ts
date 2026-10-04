import { describe, expect, it } from "bun:test";
import { looksBinary, mergeFile } from "../src/index.ts";

describe("mergeFile", () => {
  it("returns ours when both sides are identical", () => {
    const r = mergeFile("a\n", "b\n", "b\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("b\n");
  });

  it("takes the changed side when only one side changed", () => {
    const r = mergeFile("a\n", "a\n", "b\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("b\n");
  });

  it("cleans disjoint edits to different regions", () => {
    const base = "line1\nline2\nline3\nline4\nline5\n";
    const ours = "line1\nline2-ours\nline3\nline4\nline5\n";
    const theirs = "line1\nline2\nline3\nline4\nline5-theirs\n";
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(true);
    if (r.clean) {
      expect(r.content).toBe("line1\nline2-ours\nline3\nline4\nline5-theirs\n");
    }
  });

  it("cleans disjoint insertions", () => {
    const base = "a\nb\nc\n";
    const ours = "a\na2\nb\nc\n";
    const theirs = "a\nb\nc\nc2\n";
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\na2\nb\nc\nc2\n");
  });

  it("reports a conflict on the same line", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nB-ours\nc\n";
    const theirs = "a\nB-theirs\nc\n";
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(false);
    if (!r.clean) {
      expect(r.regions.length).toBe(1);
      expect(r.content).toContain("<<<<<<< ours");
      expect(r.content).toContain("B-ours");
      expect(r.content).toContain("B-theirs");
    }
  });

  it("treats identical overlapping edits as clean", () => {
    const base = "a\nb\nc\n";
    const same = "a\nB\nc\n";
    const r = mergeFile(base, same, same);
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nB\nc\n");
  });

  it("handles files without a trailing newline", () => {
    const r = mergeFile("a", "a", "b");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("b");
  });

  // Two different insertions at the same anchor are genuinely ambiguous, so
  // they conflict. Verified against `git merge-file`, which also conflicts.
  it("does not duplicate an identical insertion when both sides append the same line", () => {
    // Both sides insert X at the same anchor; disjoint edits are separate.
    const r = mergeFile("a\nb\n", "a\nX\nb\n", "a\nX\nb\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nX\nb\n");
  });

  it("reports a conflict for two different insertions at the same anchor", () => {
    const r = mergeFile("a\nb\n", "a\nX\nb\na2\n", "a\nY\nb\nb2\n");
    expect(r.clean).toBe(false);
  });

  it("merges an identical insertion plus a disjoint edit cleanly", () => {
    // Both insert X at the top anchor; only ours edits the tail, only theirs
    // edits elsewhere. Tail and elsewhere are single-owner chunks.
    const r = mergeFile("a\nb\nc\n", "a\nX\nb\na2\nc\n", "a\nX\nb\nc\nc2\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nX\nb\na2\nc\nc2\n");
  });

  it("does not silently drop lines when both sides edit many regions", () => {
    const base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
    const ours = "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
    const theirs = "l1\nl2\nl3\nL4\nl5\nl6\nl7\nL8\n";
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("L1\nl2\nl3\nL4\nl5\nl6\nl7\nL8\n");
  });
});

describe("looksBinary", () => {
  it("detects a NUL byte", () => {
    expect(looksBinary(new Uint8Array([1, 2, 0, 3]))).toBe(true);
  });

  it("treats text as text", () => {
    expect(looksBinary(new TextEncoder().encode("hello\nworld\n"))).toBe(false);
  });
});
