import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";

/** Small find widget in the top-right corner of a terminal (Ctrl+F). */
export function TerminalSearch({ addon, onClose, initialQuery = "" }: { addon: SearchAddon; onClose: () => void; initialQuery?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    if (initialQuery) addon.findPrevious(initialQuery); // last occurrence first
  }, [addon, initialQuery]);

  const find = (backwards = false) => {
    if (!query) return;
    const found = backwards ? addon.findPrevious(query) : addon.findNext(query);
    setNotFound(!found);
  };

  return (
    <div className="absolute right-4 top-1 z-10 flex items-center gap-1 rounded border border-lf-border bg-lf-elevated p-1 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        placeholder="Szukaj"
        aria-label="Szukaj w terminalu"
        onChange={(e) => {
          setQuery(e.target.value);
          setNotFound(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey);
          else if (e.key === "Escape") onClose();
        }}
        className={`w-48 rounded border bg-lf-editor px-2 py-0.5 text-xs text-lf-fg outline-none ${
          notFound ? "border-lf-danger" : "border-lf-border focus:border-lf-accent"
        }`}
      />
      <IconButton icon="arrow-up" label="Poprzedni (Shift+Enter)" onClick={() => find(true)} />
      <IconButton icon="arrow-down" label="Następny (Enter)" onClick={() => find(false)} />
      <IconButton icon="close" label="Zamknij (Esc)" onClick={onClose} />
    </div>
  );
}

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
    >
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
