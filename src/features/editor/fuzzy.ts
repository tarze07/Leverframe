/**
 * Fuzzy matching for quick open: all query characters must appear in order. Matches at the start
 * of the file name, after separators and in consecutive runs score higher; shorter paths win ties.
 */
export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indices of matched characters in `path` (for highlighting). */
  positions: number[];
}

const isBoundary = (ch: string | undefined) => ch === undefined || ch === "/" || ch === "\\" || ch === "_" || ch === "-" || ch === "." || ch === " ";

export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;

  // Prefer matching inside the file name: try from the name first, then from the start.
  const attempt = (from: number): FuzzyMatch | null => {
    const positions: number[] = [];
    let i = from;
    for (const ch of q) {
      const found = lower.indexOf(ch, i);
      if (found < 0) return null;
      positions.push(found);
      i = found + 1;
    }
    let score = 0;
    positions.forEach((p, k) => {
      score += 1;
      if (p >= nameStart) score += 2;
      if (isBoundary(path[p - 1])) score += 3;
      if (k > 0 && positions[k - 1] === p - 1) score += 4;
      if (path[p] !== lower[p] && path[p] === query.replace(/\s+/g, "")[k]) score += 1; // case matches
    });
    if (positions[0] === nameStart) score += 5;
    score -= path.length * 0.01;
    return { path, score, positions };
  };

  const inName = attempt(nameStart);
  const anywhere = attempt(0);
  if (inName && anywhere) return inName.score >= anywhere.score ? inName : anywhere;
  return inName ?? anywhere;
}

export function fuzzyFilter(query: string, paths: string[], limit = 50): FuzzyMatch[] {
  const out: FuzzyMatch[] = [];
  for (const p of paths) {
    const m = fuzzyMatch(query, p);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}
