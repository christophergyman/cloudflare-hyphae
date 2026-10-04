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

/**
 * Safety ceiling on file size (in lines). Myers runs in O(ND) time and keeps a
 * snapshot of the frontier at each d for backtracking, so peak memory is
 * O(D*(n+m)): bounded by the edit distance rather than n*m, but still
 * proportional to it. This is a very high guard against pathological inputs,
 * not a normal limit. Files up to this size merge in the fast path.
 */
const MAX_LINES = 200_000;

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
 * A line diff (base -> other) as a list of hunks.
 *
 * Uses Myers' O(ND) diff, where D is the number of differences. Time is
 * near-linear for real merges (few changes relative to file size), and unlike an
 * LCS table it does not allocate O(n*m) memory. Backtracking keeps a snapshot of
 * the frontier at each d, so peak memory is O(D*(n+m)): bounded by the edit
 * distance, but still proportional to it. That is what lets large files with
 * small edits merge cleanly instead of falling back to a whole-file conflict.
 *
 * Hunks are non-overlapping and ordered by baseStart. Insertions have
 * baseStart === baseEnd.
 */
function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;

  // Myers shortest edit script from base -> other.
  const max = n + m;
  if (max === 0) return [];
  const vSize = 2 * max + 1;
  const offset = max;
  const v = new Int32Array(vSize);
  // trace of v at each d, to reconstruct the path.
  const trace: Int32Array[] = [];

  let foundD = -1;
  outer: for (let d = 0; d <= max; d++) {
    const vSnapshot = v.slice();
    trace.push(vSnapshot);
    for (let k = -d; k <= d; k += 2) {
      const ki = k + offset;
      let x: number;
      if (k === -d || (k !== d && (v[ki - 1] ?? 0) < (v[ki + 1] ?? 0))) {
        x = v[ki + 1] ?? 0; // down: insertion
      } else {
        x = (v[ki - 1] ?? 0) + 1; // right: deletion
      }
      let y = x - k;
      while (x < n && y < m && base[x] === other[y]) {
        x++;
        y++;
      }
      v[ki] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break outer;
      }
    }
  }

  // Backtrack to recover the edit path as (base index, other index) moves.
  const moves: { type: "keep" | "insert" | "delete" }[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d] as Int32Array;
    const k = x - y;
    const ki = k + offset;
    const down = k === -d || (k !== d && (vPrev[ki - 1] ?? 0) < (vPrev[ki + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[prevK + offset] ?? 0;
    const prevY = prevX - prevK;
    // Diagonal (keep) moves after the snake.
    while (x > prevX && y > prevY) {
      moves.push({ type: "keep" });
      x--;
      y--;
    }
    if (down) {
      moves.push({ type: "insert" });
      y--;
    } else {
      moves.push({ type: "delete" });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    moves.push({ type: "keep" });
    x--;
    y--;
  }
  while (x > 0) {
    moves.push({ type: "delete" });
    x--;
  }
  while (y > 0) {
    moves.push({ type: "insert" });
    y--;
  }
  moves.reverse();

  // Turn the move list into hunks over base indices.
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };

  let bi = 0;
  let oi = 0;
  for (const move of moves) {
    if (move.type === "keep") {
      flush();
      bi++;
      oi++;
      continue;
    }
    if (!cur) cur = { baseStart: bi, baseEnd: bi, replacement: [] };
    if (move.type === "delete") {
      bi++;
      cur.baseEnd = bi;
    } else {
      cur.replacement.push(other[oi] as string);
      oi++;
    }
  }
  flush();
  return hunks;
}

interface Chunk {
  baseStart: number;
  baseEnd: number;
  ours: Hunk[];
  theirs: Hunk[];
}

/**
 * Running summary of a chunk's base span, used to test whether the next hunk
 * competes without rescanning every hunk already in the chunk.
 *
 * `lo`/`hi` are the min baseStart / max baseEnd seen. `hasRange` is true once a
 * non-insertion (baseStart < baseEnd) is present; the ranges in a chunk are
 * always contiguous (each absorbed hunk competes with the union, so no gap can
 * form). `insLo`/`insHi` record whether an insertion sits exactly on the span's
 * start/end, because such an insertion competes with a hunk that touches the
 * boundary even when their half-open ranges do not intersect.
 */
interface ChunkState {
  lo: number;
  hi: number;
  hasRange: boolean;
  insLo: boolean;
  insHi: boolean;
}

/**
 * Whether `h` competes with the base span summarized by `s`.
 *
 * Because a chunk's ranges stay contiguous, intersecting the summary span is
 * equivalent to intersecting at least one member range; insertions only need
 * the boundary flags above.
 */
function competesWithChunk(h: Hunk, s: ChunkState): boolean {
  const insertion = h.baseStart === h.baseEnd;
  if (insertion) {
    // An insertion competes with a range containing its anchor (inclusive), or
    // with another insertion at the exact same anchor.
    if (s.hasRange) return h.baseStart >= s.lo && h.baseStart <= s.hi;
    return h.baseStart === s.lo;
  }
  if (s.hasRange) {
    if (h.baseStart < s.hi && s.lo < h.baseEnd) return true;
    if (s.insLo && h.baseEnd === s.lo && h.baseStart <= s.lo) return true;
    if (s.insHi && h.baseStart === s.hi && h.baseEnd >= s.hi) return true;
    return false;
  }
  // Only insertions so far, all at the same anchor: the new range competes iff
  // it contains that anchor.
  return h.baseStart <= s.lo && s.lo <= h.baseEnd;
}

/** Fold an absorbed hunk into the running chunk summary. O(1). */
function absorbIntoChunk(s: ChunkState, h: Hunk): void {
  const insertion = h.baseStart === h.baseEnd;
  const prevLo = s.lo;
  const prevHi = s.hi;
  s.lo = Math.min(s.lo, h.baseStart);
  s.hi = Math.max(s.hi, h.baseEnd);
  // A boundary insertion only stays relevant if the boundary did not move.
  if (s.lo !== prevLo) s.insLo = false;
  if (s.hi !== prevHi) s.insHi = false;
  if (insertion) {
    if (h.baseStart === s.lo) s.insLo = true;
    if (h.baseStart === s.hi) s.insHi = true;
  } else {
    s.hasRange = true;
  }
}

/**
 * Walk both hunk lists in base order and build chunks. A chunk grows while the
 * next hunk (from either side, whichever comes first) competes with or touches
 * a hunk already in the chunk. This is the minimal set of base regions the two
 * sides disagree about.
 *
 * Each hunk is considered at most a constant number of times, so building a
 * chunk with k hunks is O(k) rather than O(k^2).
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
    const state: ChunkState = {
      lo: seed.baseStart,
      hi: seed.baseEnd,
      hasRange: seed.baseStart < seed.baseEnd,
      insLo: seed.baseStart === seed.baseEnd,
      insHi: seed.baseStart === seed.baseEnd,
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
        if (!competesWithChunk(h, state)) return;
        if (side === "ours") {
          chunk.ours.push(h);
          oi++;
        } else {
          chunk.theirs.push(h);
          ti++;
        }
        absorbIntoChunk(state, h);
        grew = true;
      };

      consider(oi < ours.length ? (ours[oi] as Hunk) : null, "ours");
      consider(ti < theirs.length ? (theirs[ti] as Hunk) : null, "theirs");
    }

    chunk.baseStart = state.lo;
    chunk.baseEnd = state.hi;
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
