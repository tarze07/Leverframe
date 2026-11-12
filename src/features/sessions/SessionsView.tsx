import { useEffect, useId, useState } from "react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useSessionsStore } from "../../store/sessions";
import { useTerminalStore } from "../../store/terminal";
import { openAgentChatHistory, openSessionPlayer } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { formatDuration, snippetParts, type DateRange, type SessionKind, type SessionRecord } from "./sessionsClient";
import { AgentLogsList } from "./AgentLogsList";
import { RANGES, selectClass } from "./filters";

type Tab = "logs" | "recordings";

/** Sidebar view: the agents' own conversation logs and terminal recordings. */
export function SessionsView() {
  const [tab, setTab] = useState<Tab>("logs");
  if (!isTauri()) {
    return (
      <Placeholder icon="history" title="Sesje agentów">
        Historia sesji jest dostępna w aplikacji desktopowej (<code className="font-mono">npm run tauri dev</code>).
      </Placeholder>
    );
  }
  return (
    <div className="flex flex-col">
      <div role="tablist" aria-label="Rodzaj sesji" className="mx-3 mb-2 flex rounded border border-lf-border p-0.5 text-xs">
        {(
          [
            ["logs", "Rozmowy"],
            ["recordings", "Historia"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded px-2 py-0.5 ${tab === id ? "bg-lf-elevated text-lf-fg" : "text-lf-muted hover:text-lf-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "logs" ? <AgentLogsList /> : <RecordingsList />}
    </div>
  );
}

/** Recorded agent sessions (terminal recordings and ACP conversations) with full-text search and filters. */
function RecordingsList() {
  const { filters, sessions, facets, status, error, recordingEnabled, setFilters, resetFilters, refresh, loadInfo, setRecording, clear } =
    useSessionsStore();
  // Refresh when a terminal finishes or starts (a recording may have been added or closed).
  const runningKey = useTerminalStore((s) => s.running.map((r) => `${r.panelId}:${r.exited}`).join(","));
  const [query, setQuery] = useState(filters.query);
  const [confirmClear, setConfirmClear] = useState(false);
  const searchId = useId();

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  // Debounced search input.
  useEffect(() => {
    const t = setTimeout(() => setFilters({ query }), 250);
    return () => clearTimeout(t);
  }, [query, setFilters]);

  useEffect(() => {
    void refresh();
  }, [filters, runningKey, refresh]);

  // While a session is running (listed, or an agent terminal is open), keep the list and search
  // results up to date – its output becomes searchable within seconds.
  const agentRunning = useTerminalStore((s) => s.running.some((r) => r.agentId && !r.exited));
  const hasRunning = agentRunning || sessions.some((s) => s.endedAt === null);
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [hasRunning, refresh]);

  const hasFilters = filters.kind || filters.agentId || filters.profileId || filters.cwd || filters.range !== "all" || filters.query;

  return (
    <div className="flex flex-col gap-2 px-3 pb-4">
      <div className="relative">
        <span className="codicon codicon-search pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-lf-subtle" aria-hidden />
        <label htmlFor={searchId} className="sr-only">
          Szukaj w sesjach
        </label>
        <input
          id={searchId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj w nagraniach i rozmowach…"
          className="w-full rounded border border-lf-border bg-lf-editor py-1 pl-7 pr-2 text-xs text-lf-fg outline-none placeholder:text-lf-subtle focus:border-lf-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-1">
        <select
          aria-label="Rodzaj"
          value={filters.kind}
          onChange={(e) => setFilters({ kind: e.target.value as "" | SessionKind })}
          className={`${selectClass} col-span-2`}
        >
          <option value="">Nagrania terminala i rozmowy</option>
          <option value="terminal">Nagrania terminala</option>
          <option value="acp">Rozmowy (ACP)</option>
        </select>
        <select aria-label="Agent" value={filters.agentId} onChange={(e) => setFilters({ agentId: e.target.value })} className={selectClass}>
          <option value="">Wszyscy agenci</option>
          {facets.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id}
            </option>
          ))}
        </select>
        <select aria-label="Profil" value={filters.profileId} onChange={(e) => setFilters({ profileId: e.target.value })} className={selectClass}>
          <option value="">Wszystkie profile</option>
          {facets.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
        <select aria-label="Projekt" value={filters.cwd} onChange={(e) => setFilters({ cwd: e.target.value })} className={selectClass}>
          <option value="">Wszystkie projekty</option>
          {facets.cwds.map((c) => (
            <option key={c} value={c} title={c}>
              {folderName(c)}
            </option>
          ))}
        </select>
        <select aria-label="Data" value={filters.range} onChange={(e) => setFilters({ range: e.target.value as DateRange })} className={selectClass}>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between text-[11px] text-lf-subtle">
        <span>
          {status === "loading" && sessions.length === 0 ? "Wczytywanie…" : `${sessions.length} ${sessions.length === 1 ? "sesja" : "sesji"}`}
        </span>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              resetFilters();
            }}
            className="text-lf-accent hover:underline"
          >
            Wyczyść filtry
          </button>
        )}
      </div>

      {error && <p className="text-[11px] text-lf-danger">{error}</p>}

      <ul className="flex flex-col gap-1" aria-label="Sesje">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} query={filters.query} />
        ))}
      </ul>

      {status === "ready" && sessions.length === 0 && (
        <p className="py-4 text-center text-xs text-lf-subtle">
          {hasFilters ? "Brak sesji pasujących do filtrów." : "Brak nagranych sesji i rozmów. Uruchom agenta w panelu „Agenci”."}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-lf-border pt-3">
        <label className="flex items-center gap-2 text-xs text-lf-fg">
          <input type="checkbox" checked={recordingEnabled} onChange={(e) => void setRecording(e.target.checked)} />
          Nagrywaj sesje i rozmowy z agentami
        </label>
        <p className="text-[11px] leading-relaxed text-lf-subtle">
          Nagrania zawierają wszystko, co pojawiło się w terminalu – także klucze i hasła, jeśli zostały wyświetlone. Rozmowy
          zapisują wiadomości, narzędzia i skrócone zmiany w plikach.
        </p>
        {confirmClear ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-lf-fg">Usunąć wszystkie zakończone sesje?</span>
            <button
              type="button"
              onClick={() => {
                setConfirmClear(false);
                void clear();
              }}
              className="rounded bg-lf-danger px-2 py-0.5 text-white"
            >
              Usuń
            </button>
            <button type="button" onClick={() => setConfirmClear(false)} className="text-lf-muted hover:text-lf-fg">
              Anuluj
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="self-start text-xs text-lf-danger hover:underline"
          >
            Wyczyść historię…
          </button>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session: s, query }: { session: SessionRecord; query: string }) {
  const remove = useSessionsStore((st) => st.remove);
  const started = new Date(s.startedAt);
  const running = s.endedAt === null;
  const chat = s.kind === "acp";
  return (
    <li
      className="group relative rounded hover:bg-lf-hover"
      aria-label={`${chat ? "Rozmowa" : "Nagranie"} ${s.agentName ?? "Sesja"} ${started.toLocaleString("pl-PL")}`}
    >
      <button
        type="button"
        onClick={() => (chat ? openAgentChatHistory(s) : openSessionPlayer(s, query))}
        className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left"
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`codicon ${chat ? "codicon-comment-discussion" : "codicon-terminal"} shrink-0 text-lf-muted`}
            title={chat ? "Rozmowa (ACP)" : "Nagranie terminala"}
            aria-hidden
          />
          <span className="truncate text-[13px] text-lf-fg">{s.agentName ?? s.agentId ?? "Sesja"}</span>
          {s.profileName && <span className="truncate text-[11px] text-lf-subtle">{s.profileName}</span>}
          {running ? (
            <span className="ml-auto shrink-0 text-[10px] uppercase text-lf-accent">trwa</span>
          ) : (
            s.exitCode !== null &&
            s.exitCode !== 0 && <span className="ml-auto shrink-0 text-[10px] text-lf-danger">kod {s.exitCode}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-lf-muted">
          <span>{started.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}</span>
          {!running && <span>· {formatDuration((s.endedAt ?? s.startedAt) - s.startedAt)}</span>}
          {s.cwd && (
            <span className="truncate" title={s.cwd}>
              · {folderName(s.cwd)}
            </span>
          )}
        </div>
        {chat && s.title && <p className="truncate text-[12px] text-lf-fg/90">{s.title}</p>}
        {s.snippet && (
          <p className="line-clamp-2 break-all font-mono text-[11px] text-lf-muted">
            {snippetParts(s.snippet).map((p, i) =>
              p.match ? (
                <mark key={i} className="rounded-sm bg-lf-accent/30 text-lf-fg">
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </p>
        )}
      </button>
      {!running && (
        <button
          type="button"
          title="Usuń sesję"
          aria-label="Usuń sesję"
          onClick={() => void remove(s.id)}
          className="absolute right-1 top-1 hidden rounded p-0.5 text-lf-muted hover:bg-lf-elevated hover:text-lf-fg group-focus-within:block group-hover:block"
        >
          <span className="codicon codicon-trash" aria-hidden />
        </button>
      )}
    </li>
  );
}
