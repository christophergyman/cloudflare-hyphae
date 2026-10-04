import { describe, expect, it } from "bun:test";
import { mergeFile } from "../src/index.ts";

/**
 * Behavioural guards for the merge core, written as explicit expectations
 * rather than a git oracle.
 *
 * Note on divergence from `git merge-file`: git's default diff3 uses a 3-line
 * context window, so it reports a conflict when two sides edit *adjacent*
 * lines even though the edits are independent. Hyphae deliberately merges
 * those cleanly, because the product goal is "two agents editing different
 * sections of one file" and adjacent sections are common. Where the edits truly
 * overlap, we conflict, matching git.
 *
 * The invariant that matters most: a clean result must contain no dropped and
 * no duplicated base lines. See the property test at the bottom.
 */
describe("mergeFile: git-aligned behaviour", () => {
  it("merges edits to fully disjoint regions cleanly", () => {
    const r = mergeFile("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nB\nC\n");
  });

  it("merges adjacent-line edits cleanly (stricter than git's default)", () => {
    const r = mergeFile("a\nb\nc\nd\n", "a\nB1\nc\nd\n", "a\nb\nC1\nd\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nB1\nC1\nd\n");
  });

  it("conflicts on a genuine same-line overlap", () => {
    const r = mergeFile("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n");
    expect(r.clean).toBe(false);
  });

  it("merges several disjoint edits on both sides", () => {
    const r = mergeFile(
      "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n",
      "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n",
      "l1\nl2\nl3\nL4\nl5\nl6\nl7\nL8\n",
    );
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("L1\nl2\nl3\nL4\nl5\nl6\nl7\nL8\n");
  });

  it("applies an identical insertion from both sides once", () => {
    const r = mergeFile("a\nb\n", "a\nX\nb\n", "a\nX\nb\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nX\nb\n");
  });

  it("conflicts on two different insertions at the same anchor", () => {
    const r = mergeFile("a\nb\n", "a\nX\nb\n", "a\nY\nb\n");
    expect(r.clean).toBe(false);
  });

  it("takes the deleted side and the edited side as a conflict (delete vs edit)", () => {
    const r = mergeFile("a\nb\nc\n", "a\nc\n", "a\nB\nc\n");
    expect(r.clean).toBe(false);
  });

  it("merges a shared insertion with a disjoint single-owner edit", () => {
    const r = mergeFile("a\nb\nc\n", "a\nX\nb\na2\nc\n", "a\nX\nb\nc\nc2\n");
    expect(r.clean).toBe(true);
    if (r.clean) expect(r.content).toBe("a\nX\nb\na2\nc\nc2\n");
  });

  it("groups multiple competing hunks into one chunk (insertions inside a replaced range)", () => {
    // theirs replaces base lines 2..7 with "T"; ours inserts a line at each of
    // anchors 2, 4, and 6, which all fall inside theirs' replaced range. All
    // four hunks belong to a single chunk, so the chunk builder must absorb
    // them incrementally rather than rescanning.
    const base = `${Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")}\n`;
    const ours = "l0\nl1\nO2\nl2\nl3\nO4\nl4\nl5\nO6\nl6\nl7\nl8\nl9\n";
    const theirs = "l0\nl1\nT\nl7\nl8\nl9\n";
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(false);
    if (!r.clean) {
      // A single conflict region covering the whole contested span.
      expect(r.regions.length).toBe(1);
      expect(r.content).toContain("<<<<<<< ours");
      expect(r.content).toContain(">>>>>>> theirs");
    }
  });
});

describe("mergeFile: no dropped or duplicated base lines", () => {
  // Deterministic pseudo-random generator so failures are reproducible.
  function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  it("preserves every base line not touched by either side", () => {
    const rng = makeRng(12345);
    for (let iter = 0; iter < 200; iter++) {
      const baseLines = Array.from({ length: 12 }, (_, i) => `b${i}`);
      const oursLines = baseLines.slice();
      const theirsLines = baseLines.slice();
      // Mutate a random disjoint line on each side, with padding to avoid edges.
      const oIdx = 1 + Math.floor(rng() * 5);
      const tIdx = 7 + Math.floor(rng() * 4);
      oursLines[oIdx] = `OURS_${oIdx}`;
      theirsLines[tIdx] = `THEIRS_${tIdx}`;
      const base = `${baseLines.join("\n")}\n`;
      const ours = `${oursLines.join("\n")}\n`;
      const theirs = `${theirsLines.join("\n")}\n`;
      const r = mergeFile(base, ours, theirs);
      // Disjoint single-line edits must be clean.
      expect(r.clean).toBe(true);
      if (!r.clean) continue;
      const expected = baseLines.slice();
      expected[oIdx] = `OURS_${oIdx}`;
      expected[tIdx] = `THEIRS_${tIdx}`;
      expect(r.content).toBe(`${expected.join("\n")}\n`);
    }
  });
});

describe("mergeFile: large files", () => {
  it("merges disjoint edits in a file over the old 4000-line cap", () => {
    const n = 5000;
    const base = `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
    const ours = base.replace("line 100", "line 100 OURS").replace("line 4000", "line 4000 OURS");
    const theirs = base.replace("line 2000", "line 2000 THEIRS");
    const r = mergeFile(base, ours, theirs);
    expect(r.clean).toBe(true);
    if (r.clean) {
      const lines = r.content.split("\n");
      expect(lines[100]).toBe("line 100 OURS");
      expect(lines[2000]).toBe("line 2000 THEIRS");
      expect(lines[4000]).toBe("line 4000 OURS");
      expect(lines.length).toBe(n + 1);
    }
  });
});
