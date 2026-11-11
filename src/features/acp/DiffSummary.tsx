import { useMemo } from "react";
import { openDiff } from "../../workbench/commands";
import { diffLines, diffStats, hunks } from "./lineDiff";

const MAX_PREVIEW_LINES = 12;

/** A change the agent proposes or made: file, +/− lines, a few changed lines, and the full view. */
export function DiffSummary({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const { stats, preview, more } = useMemo(() => {
    const d = diffLines(oldText, newText);
    const h = hunks(d, 1);
    return { stats: diffStats(d), preview: h.slice(0, MAX_PREVIEW_LINES), more: h.length > MAX_PREVIEW_LINES };
  }, [oldText, newText]);
  const name = path.split(/[\\/]/).pop() || path;
  const state = oldText == null ? "nowy plik" : newText === "" ? "usunięcie treści" : null;
  return (
    <div className="border-t border-lf-border px-2 py-1" aria-label={`Zmiana: ${name}`}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="codicon codicon-diff text-lf-muted" aria-hidden />
        <span className="min-w-0 truncate font-mono text-lf-fg" title={path}>
          {name}
        </span>
        {state && <span className="text-lf-subtle">{state}</span>}
        <span className="lf-diff-add">+{stats.added}</span>
        <span className="text-lf-danger">−{stats.removed}</span>
        <button
          type="button"
          onClick={() => openDiff({ path, oldText: oldText ?? null, newText })}
          className="ml-auto text-lf-accent hover:underline"
        >
          Otwórz zmianę
        </button>
      </div>
      {preview.length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded bg-lf-bg py-0.5 font-mono text-[11px] leading-snug">
          {preview.map((l, i) =>
            l === null ? (
              <div key={i} className="px-2 text-lf-subtle">
                ⋯
              </div>
            ) : (
              <div
                key={i}
                className={`px-2 ${l.kind === "add" ? "lf-diff-add-line text-lf-fg" : l.kind === "del" ? "bg-lf-danger/15 text-lf-muted line-through decoration-lf-danger/40" : "text-lf-muted"}`}
              >
                {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                {l.text}
              </div>
            ),
          )}
          {more && <div className="px-2 text-lf-subtle">⋯ więcej w „Otwórz zmianę”</div>}
        </pre>
      )}
    </div>
  );
}
