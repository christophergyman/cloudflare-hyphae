/**
 * The 3-way merge core (ADR-005).
 *
 * Line-based, runtime-agnostic, no dependencies. It merges edits to disjoint
 * regions cleanly (the common case: two agents editing different sections of
 * one file) and reports overlapping edits as conflicts for the merging agent.
 *
 * The algorithm is the classic diff3 chunk walk:
 *   1. Diff base against ours and base against theirs into line hunks.
 *   2. Walk both hunk lists together, grouping any hunks whose base ranges
 *      compete or touch into a single chunk (the minimal stable chunk).
 *   3. For each chunk, produce what ours and theirs say that chunk should be.
 *      If the two are identical, apply it. Otherwise it is a conflict.
 *   4. Everything outside the chunks is copied from the base.
 *
 * This guarantees no base line is ever dropped or duplicated: every base line
 * is either inside a chunk (decided by ours/theirs) or copied through.
 *
 * The public API (`mergeFile`) is what the Hub depends on and must not change.
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

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * A line diff (base -> other) as a list of hunks, via an LCS table. Hunks are
 * non-overlapping and ordered by baseStart. Insertions have baseStart === baseEnd.
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
    const dpRow = dp[i] as number[];
    const dpNext = dp[i + 1] as number[];
    const canInsert = j < m && (i >= n || (dpRow[j + 1] ?? 0) >= (dpNext[j] ?? 0));
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

/**
 * Two hunks compete when their base ranges intersect. Pure insertions (empty
 * range) compete when they target the same anchor, and also when one insertion
 * targets an anchor strictly inside the other's replaced range.
 */
function hunksCompete(a: Hunk, b: Hunk): boolean {
  const aInsertion = a.baseStart === a.baseEnd;
  const bInsertion = b.baseStart === b.baseEnd;
  if (aInsertion && bInsertion) return a.baseStart === b.baseStart;
  if (aInsertion) return a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd;
  if (bInsertion) return b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

interface Chunk {
  baseStart: number;
  baseEnd: number;
  ours: Hunk[];
  theirs: Hunk[];
}

/**
 * Walk both hunk lists in base order and build chunks. A chunk grows while the
 * next hunk (from either side, whichever comes first) competes with or touches
 * a hunk already in the chunk. This is the minimal set of base regions the two
 * sides disagree about.
 */
function buildChunks(ours: Hunk[], theirs: Hunk[]): Chunk[] {
  const chunks: Chunk[] = [];
  let oi = 0;
  let ti = 0;

  while (oi < ours.length || ti < theirs.length) {
    const oh = oi < ours.length ? (ours[oi] as Hunk) : null;
    const th = ti < theirs.length ? (theirs[ti] as Hunk) : null;

    // Seed the chunk with whichever hunk comes first.
    const ohFirst = oh !== null && (th === null || oh.baseStart <= th.baseStart);
    const seed = (ohFirst ? oh : th) as Hunk;
    const chunk: Chunk = {
      baseStart: seed.baseStart,
      baseEnd: seed.baseEnd,
      ours: [],
      theirs: [],
    };
    if (ohFirst) {
      chunk.ours.push(oh as Hunk);
      oi++;
    } else {
      chunk.theirs.push(th as Hunk);
      ti++;
    }

    // Absorb only hunks that genuinely compete for this chunk's base span.
    // Adjacent-but-disjoint edits stay in their own chunks so each is decided
    // by the single side that made it.
    let grew = true;
    while (grew) {
      grew = false;

      const consider = (h: Hunk | null, side: "ours" | "theirs"): void => {
        if (!h) return;
        const competes = [...chunk.ours, ...chunk.theirs].some((c) => hunksCompete(c, h));
        if (!competes) return;
        if (side === "ours") {
          chunk.ours.push(h);
          oi++;
        } else {
          chunk.theirs.push(h);
          ti++;
        }
        chunk.baseEnd = Math.max(chunk.baseEnd, h.baseEnd);
        grew = true;
      };

      consider(oi < ours.length ? (ours[oi] as Hunk) : null, "ours");
      consider(ti < theirs.length ? (theirs[ti] as Hunk) : null, "theirs");
    }

    chunks.push(chunk);
  }
  return chunks;
}

/**
 * One side's version of a chunk's base span, by applying that side's hunks
 * inside [start, end) and copying base lines they do not replace.
 */
function sideVersion(hunks: Hunk[], start: number, end: number, base: string[]): string[] {
  const out: string[] = [];
  let cursor = start;
  for (const h of hunks) {
    if (h.baseEnd < start || h.baseStart > end) continue;
    while (cursor < Math.min(h.baseStart, end)) {
      out.push(base[cursor] as string);
      cursor++;
    }
    out.push(...h.replacement);
    cursor = Math.max(cursor, h.baseEnd);
  }
  while (cursor < end) {
    out.push(base[cursor] as string);
    cursor++;
  }
  return out;
}

function conflictMarkers(ours: string[], theirs: string[]): string {
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
    return { clean: false, regions: [region], content: conflictMarkers(ours, theirs) };
  }

  const oursHunks = diffHunks(base, ours);
  const theirsHunks = diffHunks(base, theirs);
  const chunks = buildChunks(oursHunks, theirsHunks);

  const out: string[] = [];
  const regions: MergeConflictRegion[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    // Copy the untouched base lines before this chunk.
    while (cursor < chunk.baseStart) {
      out.push(base[cursor] as string);
      cursor++;
    }

    const baseRegion = base.slice(chunk.baseStart, chunk.baseEnd);
    const oursPart = sideVersion(chunk.ours, chunk.baseStart, chunk.baseEnd, base);
    const theirsPart = sideVersion(chunk.theirs, chunk.baseStart, chunk.baseEnd, base);

    // Only one side changed this chunk: take that side, no conflict.
    if (chunk.theirs.length === 0) {
      out.push(...oursPart);
    } else if (chunk.ours.length === 0) {
      out.push(...theirsPart);
    } else if (sameStrings(oursPart, theirsPart)) {
      // Both sides agree: apply once.
      out.push(...oursPart);
    } else {
      regions.push({ base: baseRegion, ours: oursPart, theirs: theirsPart });
      out.push(...conflictMarkers(oursPart, theirsPart).split("\n"));
    }
    cursor = chunk.baseEnd;
  }

  // Copy any remaining base lines after the last chunk.
  while (cursor < base.length) {
    out.push(base[cursor] as string);
    cursor++;
  }

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
