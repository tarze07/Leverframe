import { useState } from "react";
import type { ToolKind, ToolStatus } from "./acpClient";
import { blockText, type ToolCallState } from "./chatState";
import { openFile } from "../../workbench/commands";

const KIND_ICONS: Record<ToolKind, string> = {
  read: "file",
  edit: "edit",
  delete: "trash",
  move: "arrow-swap",
  search: "search",
  execute: "terminal",
  think: "lightbulb",
  fetch: "globe",
  switch_mode: "settings-gear",
  other: "tools",
};

const STATUS: Record<ToolStatus, { label: string; icon: string; className: string }> = {
  pending: { label: "oczekuje", icon: "circle-large-outline", className: "text-lf-subtle" },
  in_progress: { label: "w toku", icon: "loading codicon-modifier-spin", className: "text-lf-accent" },
  completed: { label: "gotowe", icon: "pass", className: "text-lf-muted" },
  failed: { label: "błąd", icon: "error", className: "text-lf-danger" },
};

const MAX_OUTPUT = 4000;

/** One tool call of the agent: what, where (files and lines), status and its output. */
export function ToolCard({ tool, toLocal }: { tool: ToolCallState; toLocal: (path: string) => string | null }) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS[tool.status] ?? STATUS.pending;
  const output = tool.content
    .map((c) => (c.type === "content" ? blockText(c.content) : ""))
    .filter(Boolean)
    .join("\n");
  const long = output.length > MAX_OUTPUT;
  const changes = tool.content.filter((c) => c.type === "diff");
  const terminals = tool.content.filter((c) => c.type === "terminal");

  return (
    <div role="group" aria-label={`Narzędzie: ${tool.title}`} className="mb-2 rounded border border-lf-border bg-lf-sidebar">
      <div className="flex items-center gap-2 px-2 py-1">
        <span className={`codicon codicon-${KIND_ICONS[tool.kind] ?? "tools"} text-lf-muted`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-lf-fg" title={tool.title}>
          {tool.title}
        </span>
        <span className={`flex shrink-0 items-center gap-1 ${status.className}`}>
          <span className={`codicon codicon-${status.icon}`} aria-hidden />
          {status.label}
        </span>
      </div>
      {tool.locations.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {tool.locations.map((l, i) => {
            const local = toLocal(l.path);
            const label = `${l.path.split(/[\\/]/).pop() || l.path}${l.line ? `:${l.line}` : ""}`;
            return (
              <button
                key={`${l.path}:${l.line ?? ""}:${i}`}
                type="button"
                disabled={!local}
                title={local ? `Otwórz ${l.path}${l.line ? ` (linia ${l.line})` : ""}` : `${l.path} – plik na serwerze`}
                onClick={() => local && openFile(local, { line: l.line ?? undefined })}
                className="rounded bg-lf-bg px-1.5 py-0.5 font-mono text-[11px] text-lf-accent hover:underline disabled:text-lf-subtle disabled:no-underline"
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {changes.map((c) => (
        <p key={c.path} className="px-2 pb-1 text-[11px] text-lf-muted">
          <span className="codicon codicon-diff align-middle" aria-hidden /> Zmiana pliku <span className="font-mono">{c.path}</span>
        </p>
      ))}
      {terminals.length > 0 && <p className="px-2 pb-1 text-[11px] text-lf-muted">Polecenie w terminalu agenta</p>}
      {output && (
        <div className="border-t border-lf-border px-2 py-1">
          <pre className={`overflow-auto whitespace-pre-wrap font-mono text-[11px] text-lf-muted ${expanded ? "max-h-96" : "max-h-24"}`}>
            {long && !expanded ? `${output.slice(0, MAX_OUTPUT)}…` : output}
          </pre>
          {(long || output.split("\n").length > 6) && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="text-[11px] text-lf-accent hover:underline">
              {expanded ? "Zwiń" : "Pokaż całość"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
