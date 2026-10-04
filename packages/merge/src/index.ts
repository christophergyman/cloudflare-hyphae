/**
 * The 3-way merge core (ADR-005).
 *
 * First cut: line-based, runtime-agnostic, no dependencies. It cleanly merges
 * edits to disjoint regions, which is the common case (two agents editing
 * different sections of one file). Overlapping edits are reported as
 * conflicts for the merging agent to resolve.
 *
 * Phase 1 hardens this with a full diff3 and property tests. The public API
 * (`mergeFile`) is what the Hub depends on and must not change.
 */

export interface MergeClean {
  clean: true;
  content: string;
}

export interface MergeConflictRegion {
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface MergeConflict {
  clean: false;
  regions: MergeConflictRegion[];
  /** Best-effort content with conflict markers, for surfacing to a human. */
  content: string;
}

export type MergeResult = MergeClean | MergeConflict;

/** Largest file (in lines) we attempt to merge in the fast path. */
const MAX_LINES = 4000;

interface Hunk {
  /** Base range replaced: [baseStart, baseEnd). */
  baseStart: number;
  baseEnd: number;
  /** Lines that replace the base range. */
  replacement: string[];
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * A line diff (base -> other) as a list of hunks, via an LCS table.
 * Hunks are non-overlapping and ordered.
 */
function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // dp[i][j] = LCS length of base[i..] and other[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        base[i] === other[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    const canInsert =
      j < m && (i >= n || (dp[i] as number[])[j + 1]! >= (dp[i + 1] as number[])[j]!);
    if (canInsert) {
      if (!cur) cur = { baseStart: i, baseEnd: i, replacement: [] };
      cur.replacement.push(other[j] as string);
      j++;
    } else {
      if (!cur) cur = { baseStart: i, baseEnd: i, replacement: [] };
      i++;
      cur.baseEnd = i;
    }
  }
  flush();
  return hunks;
}

function conflictMarkers(base: string[], ours: string[], theirs: string[]): string {
  void base;
  return ["<<<<<<< ours", ...ours, "=======", ...theirs, ">>>>>>> theirs"].join("\n");
}

export function mergeFile(baseText: string, oursText: string, theirsText: string): MergeResult {
  // Fast paths.
  if (oursText === theirsText) return { clean: true, content: oursText };
  if (baseText === oursText) return { clean: true, content: theirsText };
  if (baseText === theirsText) return { clean: true, content: oursText };

  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);

  if (base.length > MAX_LINES || ours.length > MAX_LINES || theirs.length > MAX_LINES) {
    const region: MergeConflictRegion = { base, ours, theirs };
    return { clean: false, regions: [region], content: conflictMarkers(base, ours, theirs) };
  }

  const oursHunks = diffHunks(base, ours);
  const theirsHunks = diffHunks(base, theirs);

  const out: string[] = [];
  const regions: MergeConflictRegion[] = [];

  let i = 0;
  let oi = 0;
  let ti = 0;

  const emitBaseUpTo = (end: number) => {
    while (i < end) {
      out.push(base[i] as string);
      i++;
    }
  };

  while (oi < oursHunks.length || ti < theirsHunks.length) {
    const oh = oi < oursHunks.length ? (oursHunks[oi] as Hunk) : null;
    const th = ti < theirsHunks.length ? (theirsHunks[ti] as Hunk) : null;

    // Choose the next hunk by start position; ties favor ours (handled as overlap).
    const useOurs = oh !== null && (th === null || oh.baseStart <= th.baseStart);
    const next = useOurs ? (oh as Hunk) : (th as Hunk);
    const other = useOurs ? th : oh;

    // Does the other side's next hunk overlap this one's base range?
    if (other !== null && other.baseStart < next.baseEnd) {
      // Overlapping edits: conflict. Extend across any further hunks inside the union.
      const regionStart = next.baseStart;
      const regionEnd = Math.max(next.baseEnd, other.baseEnd);

      // If either side has more hunks inside the union, fall back to whole-file
      // conflict; this first cut only handles a single overlapping pair.
      const extraOurs = useOurs ? ti + 1 : oi + 1;
      const extraTheirs = useOurs ? oi + 1 : ti + 1;
      const moreOurs =
        extraOurs < oursHunks.length && (oursHunks[extraOurs] as Hunk).baseStart < regionEnd;
      const moreTheirs =
        extraTheirs < theirsHunks.length &&
        (theirsHunks[extraTheirs] as Hunk).baseStart < regionEnd;

      if (moreOurs || moreTheirs) {
        const region: MergeConflictRegion = { base, ours, theirs };
        return { clean: false, regions: [region], content: conflictMarkers(base, ours, theirs) };
      }

      emitBaseUpTo(regionStart);
      const baseRegion = base.slice(regionStart, regionEnd);
      const oursRep = useOurs ? next.replacement : other.replacement;
      const theirsRep = useOurs ? other.replacement : next.replacement;

      // If both produced the same replacement, it is not a conflict.
      if (oursRep.length === theirsRep.length && oursRep.every((l, k) => l === theirsRep[k])) {
        out.push(...oursRep);
      } else {
        regions.push({ base: baseRegion, ours: oursRep, theirs: theirsRep });
        out.push(...conflictMarkers(baseRegion, oursRep, theirsRep).split("\n"));
      }
      i = regionEnd;
      oi++;
      ti++;
      continue;
    }

    // No overlap: apply this side's hunk alone.
    emitBaseUpTo(next.baseStart);
    out.push(...next.replacement);
    i = next.baseEnd;
    if (useOurs) oi++;
    else ti++;
  }

  emitBaseUpTo(base.length);

  if (regions.length > 0) {
    return { clean: false, regions, content: joinLines(out) };
  }
  return { clean: true, content: joinLines(out) };
}

/** True when the file appears to be binary (contains a NUL byte). */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
