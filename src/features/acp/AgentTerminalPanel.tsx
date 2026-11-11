import type { IDockviewPanelProps } from "dockview-react";
import { useAgentTerminalsStore } from "../../store/agentTerminals";
import { AgentTerminalView } from "./AgentTerminalView";

export interface AgentTerminalParams {
  storeKey: string;
}

/** An agent's command full size in the terminal panel ("Otwórz jako terminal"), read-only. */
export function AgentTerminalPanel({ params }: IDockviewPanelProps<AgentTerminalParams>) {
  const t = useAgentTerminalsStore((s) => s.terminals[params.storeKey]);
  return (
    <div className="flex h-full flex-col bg-lf-editor">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-lf-border px-2 text-[11px] text-lf-subtle">
        <span className="codicon codicon-terminal" aria-hidden />
        <code className="min-w-0 flex-1 truncate font-mono text-lf-fg" title={t?.command}>
          {t?.command ?? "Polecenie agenta"}
        </code>
        {t?.cwd && <span className="truncate">{t.cwd}</span>}
        <span>{exitText(t?.exit ?? null)}</span>
      </div>
      <div className="min-h-0 flex-1 p-1">
        <AgentTerminalView storeKey={params.storeKey} />
      </div>
    </div>
  );
}

/** "działa…", "kod 0", "zatrzymane (SIGKILL)". */
export function exitText(exit: { code: number | null; signal: string | null } | null): string {
  if (!exit) return "działa…";
  if (exit.signal) return `zatrzymane (${exit.signal})`;
  return `kod ${exit.code ?? "?"}`;
}
