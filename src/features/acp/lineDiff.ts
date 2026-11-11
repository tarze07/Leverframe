export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Above this many line pairs the comparison is skipped (the whole text counts as changed). */
const MAX_CELLS = 4_000_000;

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * Line diff of two texts (longest common subsequence). Small and exact for the sizes agents
 * change; the editor's diff view handles anything bigger.
 */
export function diffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const a = lines(oldText ?? "");
  const b = lines(newText);
  // Common head and tail first: most edits touch a small part of a file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text) => ({ kind: "del" as const, text })), ...midB.map((text) => ({ kind: "add" as const, text })));
  } else {
    // lcs[i][j] = common length of midA[i..] and midB[j..]
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i] });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        out.push({ kind: "add", text: midB[j++] });
      } else {
        out.push({ kind: "del", text: midA[i++] });
      }
    }
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })));
  return out;
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.kind === "add") added++;
    else if (d.kind === "del") removed++;
  }
  return { added, removed };
}

/** Changed lines with `context` unchanged lines around them; gaps become `null`. */
export function hunks(diff: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (out.length > 0 && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}
