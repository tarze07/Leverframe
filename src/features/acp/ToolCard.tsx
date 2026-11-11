import { useState } from "react";
import type { ToolContent, ToolKind, ToolStatus } from "./acpClient";
import { blockText, type ToolCallState } from "./chatState";
import { openAgentTerminal, openFile } from "../../workbench/commands";
import { useAgentTerminalsStore } from "../../store/agentTerminals";
import { AgentTerminalView } from "./AgentTerminalView";
import { exitText } from "./AgentTerminalPanel";
import { DiffSummary } from "./DiffSummary";

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
export function ToolCard({
  tool,
  toLocal,
  awaitingPermission = false,
  terminalKey,
}: {
  tool: ToolCallState;
  toLocal: (path: string) => string | null;
  /** A permission request shows this call's changes right now: not repeated here. */
  awaitingPermission?: boolean;
  /** Key of an agent command's output in the shared terminal store. */
  terminalKey?: (terminalId: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS[tool.status] ?? STATUS.pending;
  const output = tool.content
    .map((c) => (c.type === "content" ? blockText(c.content) : ""))
    .filter(Boolean)
    .join("\n");
  const long = output.length > MAX_OUTPUT;
  const changes = tool.content.filter((c): c is Extract<ToolContent, { type: "diff" }> => c.type === "diff");
  const terminals = tool.content.filter((c): c is Extract<ToolContent, { type: "terminal" }> => c.type === "terminal");

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
      {awaitingPermission && changes.length > 0 ? (
        <p className="px-2 pb-1 text-[11px] text-lf-muted">Zmiana czeka na Twoją zgodę – poniżej.</p>
      ) : (
        changes.map((c, i) => (
          <DiffSummary key={`${c.path}:${i}`} path={toLocal(c.path) ?? c.path} oldText={c.oldText} newText={c.newText} />
        ))
      )}
      {terminals.map((t) =>
        terminalKey ? (
          <CommandOutput key={t.terminalId} storeKey={terminalKey(t.terminalId)} title={tool.title} />
        ) : null,
      )}
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

/** A command's live output in the card, and the way to see it full size. */
function CommandOutput({ storeKey, title }: { storeKey: string; title: string }) {
  const t = useAgentTerminalsStore((s) => s.terminals[storeKey]);
  return (
    <div className="border-t border-lf-border px-2 py-1" aria-label="Wyjście polecenia">
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <code className="min-w-0 flex-1 truncate font-mono text-lf-fg" title={t?.command}>
          {t?.command ?? ""}
        </code>
        <span className="text-lf-subtle">{exitText(t?.exit ?? null)}</span>
        <button type="button" onClick={() => openAgentTerminal(storeKey, title)} className="text-lf-accent hover:underline">
          Otwórz jako terminal
        </button>
      </div>
      <AgentTerminalView storeKey={storeKey} rows={8} />
    </div>
  );
}
