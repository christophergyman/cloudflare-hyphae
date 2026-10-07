/**
 * A compact line diff for the preview pane.
 *
 * Common prefix/suffix lines are trimmed first (the common case for edits to
 * large files), then a bounded LCS handles the middle. If the middles are both
 * huge, we fall back to a full replace block rather than burning memory, which
 * keeps the UI honest about the size of the change.
 */

export interface DiffLine {
  /** A stable identity for rendering; assigned once when the diff is built. */
  id: number;
  type: "same" | "add" | "del";
  text: string;
}

const MAX_DP_CELLS = 250_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const result: Array<Omit<DiffLine, "id">> = [];

  for (let i = 0; i < start; i++) result.push({ type: "same", text: a[i] ?? "" });

  if (midA.length * midB.length <= MAX_DP_CELLS) {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] =
          midA[i] === midB[j]
            ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        result.push({ type: "same", text: midA[i] ?? "" });
        i++;
        j++;
      } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
        result.push({ type: "del", text: midA[i] ?? "" });
        i++;
      } else {
        result.push({ type: "add", text: midB[j] ?? "" });
        j++;
      }
    }
    while (i < n) {
      result.push({ type: "del", text: midA[i] ?? "" });
      i++;
    }
    while (j < m) {
      result.push({ type: "add", text: midB[j] ?? "" });
      j++;
    }
  } else {
    for (const line of midA) result.push({ type: "del", text: line });
    for (const line of midB) result.push({ type: "add", text: line });
  }

  for (let i = endA; i < a.length; i++) result.push({ type: "same", text: a[i] ?? "" });
  return result.map((line, index) => ({ ...line, id: index }));
}
