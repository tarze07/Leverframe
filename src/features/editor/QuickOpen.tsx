import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentsStore } from "../../store/agents";
import { useUiStore } from "../../store/ui";
import { openFile } from "../../workbench/commands";
import { errorMessage, fsClient, joinPath } from "./fsClient";
import { fuzzyFilter } from "./fuzzy";

/** Ctrl+P: fuzzy file finder over the project folder. */
export function QuickOpen() {
  const open = useUiStore((s) => s.quickOpen);
  if (!open) return null;
  return <QuickOpenDialog />;
}

function QuickOpenDialog() {
  const setOpen = useUiStore((s) => s.setQuickOpen);
  const projectDir = useAgentsStore((s) => s.projectDir);
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (!projectDir) return;
    let cancelled = false;
    fsClient
      .listFiles(projectDir)
      .then((list) => {
        if (cancelled) return;
        setFiles(list.files);
        setTruncated(list.truncated);
      })
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const results = useMemo(() => (files ? fuzzyFilter(query, files, 50) : []), [files, query]);

  const choose = (rel: string | undefined) => {
    if (!rel || !projectDir) return;
    setOpen(false);
    openFile(joinPath(projectDir, rel));
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-16" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label="Szybkie otwieranie"
        className="flex h-fit max-h-[60vh] w-[min(600px,90vw)] flex-col overflow-hidden rounded-md border border-lf-border bg-lf-elevated shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          aria-label="Nazwa pliku"
          placeholder={projectDir ? "Wpisz nazwę pliku…" : "Najpierw wybierz folder projektu (panel Pliki)"}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") choose(results[selected]?.path);
          }}
          className="border-b border-lf-border bg-lf-editor px-3 py-2 text-sm text-lf-fg outline-none placeholder:text-lf-subtle"
        />
        {error && <p className="px-3 py-2 text-xs text-lf-danger">{error}</p>}
        {projectDir && !files && !error && <p className="px-3 py-2 text-xs text-lf-muted">Wczytywanie listy plików…</p>}
        <ul role="listbox" aria-label="Pliki" className="overflow-auto py-1">
          {results.map((r, i) => {
            const slash = r.path.lastIndexOf("/");
            return (
              <li
                key={r.path}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => choose(r.path)}
                className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 text-[13px] ${i === selected ? "bg-lf-hover" : ""}`}
              >
                <span className="shrink-0 text-lf-fg">
                  <Highlighted text={r.path.slice(slash + 1)} positions={r.positions} offset={slash + 1} />
                </span>
                <span className="truncate text-xs text-lf-subtle">{slash > 0 ? r.path.slice(0, slash) : ""}</span>
              </li>
            );
          })}
        </ul>
        {files && results.length === 0 && <p className="px-3 py-2 text-xs text-lf-subtle">Brak pasujących plików</p>}
        {truncated && <p className="border-t border-lf-border px-3 py-1 text-[11px] text-lf-subtle">Pokazano pierwsze 50 000 plików folderu.</p>}
      </div>
    </div>
  );
}

function Highlighted({ text, positions, offset }: { text: string; positions: number[]; offset: number }) {
  const marks = new Set(positions.map((p) => p - offset));
  return (
    <>
      {[...text].map((ch, i) =>
        marks.has(i) ? (
          <b key={i} className="font-semibold text-lf-accent">
            {ch}
          </b>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}
