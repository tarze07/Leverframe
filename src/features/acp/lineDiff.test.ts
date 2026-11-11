import { describe, expect, it } from "vitest";
import { diffLines, diffStats, hunks } from "./lineDiff";

describe("line diff", () => {
  it("finds added, removed and kept lines", () => {
    const d = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "B" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it("treats a missing old text as a new file and an empty new text as a deletion", () => {
    expect(diffStats(diffLines(null, "x\ny"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines("x\ny\n", ""))).toEqual({ added: 0, removed: 2 });
    expect(diffLines("same\n", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  it("keeps only changes with a little context", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const changed = old.replace("l3", "X").replace("l15", "Y");
    const h = hunks(diffLines(old, changed), 1);
    expect(h.map((d) => (d ? `${d.kind[0]}:${d.text}` : "…"))).toEqual([
      "s:l2", "a:X", "d:l3", "s:l4", "…", "s:l14", "a:Y", "d:l15", "s:l16",
    ]);
  });

  it("stays fast on big files with a small change", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const t = performance.now();
    const d = diffLines(big, big.replace("line 25000", "changed"));
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(performance.now() - t).toBeLessThan(500);
  });
});
