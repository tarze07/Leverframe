import { useEffect, useId, useMemo, useState } from "react";
import { useAgentLogsStore } from "../../store/agentLogs";
import { useProfilesStore } from "../../store/profiles";
import { openAgentLog } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { LOG_AGENT_NAMES, type LogAgent, type LogSummary } from "./agentLogsClient";
import { rangeStart, type DateRange } from "./sessionsClient";
import { RANGES, selectClass } from "./filters";

/** Conversations read from the agents' own logs (Claude Code, Codex). */
export function AgentLogsList() {
  const { source, logs, status, error, setSource, refresh, watch } = useAgentLogsStore();
  const profiles = useProfilesStore((s) => s.profiles);
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<"" | LogAgent>("");
  const [range, setRange] = useState<DateRange>("all");
  const searchId = useId();

  useEffect(() => {
    void refresh();
    return watch();
  }, [refresh, watch]);

  const wslSources = profiles.filter((p) => p.kind === "wsl");
  const sshSources = profiles.filter((p) => p.kind === "ssh");
  const remote = source.startsWith("ssh:");

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    const from = rangeStart(range);
    return logs.filter(
      (l) =>
        (!agent || l.agent === agent) &&
        (from === undefined || l.updatedAt >= from) &&
        (!q || [l.title, l.cwd, l.gitBranch, l.nativeId].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [logs, text, agent, range]);

  return (
    <div className="flex flex-col gap-2 px-3 pb-4">
      <div className="relative">
        <span className="codicon codicon-filter pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-lf-subtle" aria-hidden />
        <label htmlFor={searchId} className="sr-only">
          Filtruj rozmowy
        </label>
        <input
          id={searchId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filtruj po tytule, folderze, gałęzi…"
          className="w-full rounded border border-lf-border bg-lf-editor py-1 pl-7 pr-2 text-xs text-lf-fg outline-none placeholder:text-lf-subtle focus:border-lf-accent"
        />
      </div>
      <div className="grid grid-cols-2 gap-1">
        <select aria-label="Źródło" value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
          <option value="local">Ten komputer</option>
          {wslSources.map((p) => (
            <option key={p.id} value={p.id}>
              WSL: {p.name}
            </option>
          ))}
          {sshSources.map((p) => (
            <option key={p.id} value={`ssh:${p.id}`}>
              SSH: {p.name}
            </option>
          ))}
        </select>
        <select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value as "" | LogAgent)} className={selectClass}>
          <option value="">Wszyscy agenci</option>
          {(Object.keys(LOG_AGENT_NAMES) as LogAgent[]).map((a) => (
            <option key={a} value={a}>
              {LOG_AGENT_NAMES[a]}
            </option>
          ))}
        </select>
        <select aria-label="Data" value={range} onChange={(e) => setRange(e.target.value as DateRange)} className={`${selectClass} col-span-2`}>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between text-[11px] text-lf-subtle">
        <span>{status === "loading" && logs.length === 0 ? "Wczytywanie…" : `${visible.length} z ${logs.length}`}</span>
        <button type="button" onClick={() => void refresh()} className="text-lf-accent hover:underline">
          Odśwież
        </button>
      </div>
      {remote && (
        <p className="text-[11px] leading-relaxed text-lf-subtle">
          Host SSH jest sprawdzany na żądanie (przycisk „Odśwież”) i wymaga logowania kluczem.
        </p>
      )}
      {error && <p className="text-[11px] text-lf-danger">{error}</p>}
      <ul className="flex flex-col gap-1" aria-label="Rozmowy">
        {visible.map((l) => (
          <LogRow key={l.path} log={l} />
        ))}
      </ul>
      {status === "ready" && logs.length === 0 && !error && (
        <p className="py-4 text-center text-xs leading-relaxed text-lf-subtle">
          Brak rozmów Claude Code ani Codex w tym źródle. Sesje innych agentów (Agy, Kilo Code) znajdziesz w zakładce
          „Historia”.
        </p>
      )}
    </div>
  );
}

function LogRow({ log: l }: { log: LogSummary }) {
  const when = new Date(l.updatedAt);
  return (
    <li aria-label={l.title ?? l.nativeId}>
      <button
        type="button"
        onClick={() => openAgentLog(l)}
        title={l.path}
        className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-lf-hover"
      >
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded bg-lf-elevated px-1 text-[10px] uppercase text-lf-accent">{LOG_AGENT_NAMES[l.agent]}</span>
          <span className="truncate text-[13px] text-lf-fg">{l.title ?? "(bez tytułu)"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-lf-muted">
          <span className="shrink-0">{when.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}</span>
          {l.cwd && (
            <span className="truncate" title={l.cwd}>
              · {folderName(l.cwd)}
            </span>
          )}
          {l.gitBranch && <span className="truncate">· {l.gitBranch}</span>}
        </div>
      </button>
    </li>
  );
}
