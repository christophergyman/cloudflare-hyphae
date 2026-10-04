# @hyphae/merge

The 3-way merge core (ADR-005): a line-based, dependency-free diff3 merge that
is runtime-agnostic and used on the Hub's fast path.

## Public API

Entry point: `src/index.ts`.

- `mergeFile(base, ours, theirs)`: merges disjoint edits cleanly and reports
  overlapping edits as conflicts. Returns `MergeResult`.
- `looksBinary(bytes)`: NUL-byte check, so binary files skip text merging.
- Types: `MergeResult`, `MergeClean`, `MergeConflict`, `MergeConflictRegion`.

Uses a Myers O(ND) diff, so memory is bounded by the edit distance rather than
file size. It never drops or duplicates a base line.

## Tests

```
bun test packages/merge
```
