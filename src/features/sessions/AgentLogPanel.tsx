import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { logFilePath, openCommandInTerminal, openFile } from "../../workbench/commands";
import { plural } from "../../lib/plural";
import {
  agentLogsClient,
  buildTimeline,
  changedFiles,
  LOG_AGENT_NAMES,
  resumeCommand,
  toolLabel,
  type LogDetail,
  type TimelineItem,
} from "./agentLogsClient";

export interface AgentLogParams {
  source: string;
  path: string;
}

const copy = (text: string) => void writeText(text).catch(() => undefined);
const time = (ts: number | null) =>
  ts ? new Date(ts).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

/** Timeline of one conversation from an agent's own log: messages, commands with results, edited files. */
export function AgentLogPanel({ params }: IDockviewPanelProps<AgentLogParams>) {
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyCommands, setOnlyCommands] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    agentLogsClient
      .read(params.source, params.path)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [params.source, params.path]);

  const timeline = useMemo(() => (detail ? buildTimeline(detail.entries) : []), [detail]);
  const files = useMemo(() => (detail ? changedFiles(detail.entries) : []), [detail]);

  if (error) return <p className="m-4 rounded bg-lf-elevated p-3 text-xs text-lf-danger">{error}</p>;
  if (!detail) return <p className="m-4 text-xs text-lf-muted">Wczytywanie rozmowy…</p>;

  const s = detail.summary;
  const resume = resumeCommand(s);
  const commands = timeline.filter((i) => i.kind === "tool" && i.call.command);
  const failed = commands.filter((i) => i.kind === "tool" && i.result?.isError);
  const visible = timeline.filter((i) =>
    onlyCommands ? i.kind === "tool" && !!i.call.command : i.kind !== "thinking" || showThinking,
  );

  return (
    <div className="h-full overflow-auto bg-lf-editor">
      <header className="sticky top-0 z-10 border-b border-lf-border bg-lf-editor/95 px-5 py-3 backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wide text-lf-accent">{LOG_AGENT_NAMES[s.agent]}</p>
            <h1 className="truncate text-base text-lf-fg">{s.title ?? s.nativeId}</h1>
            <p className="truncate text-xs text-lf-muted" title={s.cwd ?? undefined}>
              {[s.cwd, s.gitBranch && `gałąź ${s.gitBranch}`, s.startedAt && new Date(s.startedAt).toLocaleString("pl-PL")]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {resume && (
            <button
              type="button"
              onClick={() => openCommandInTerminal({ command: resume, source: s.source, cwd: s.cwd, submit: true, title: `${LOG_AGENT_NAMES[s.agent]} (wznowiona)` })}
              title={resume}
              className="flex shrink-0 items-center gap-1 rounded bg-lf-accent px-2 py-1 text-xs text-lf-accent-fg hover:opacity-90"
            >
              <span className="codicon codicon-debug-continue" aria-hidden />
              Wznów sesję
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-lf-muted">
          <span>
            {plural(commands.length, ["polecenie", "polecenia", "poleceń"])}
            {failed.length > 0 && <span className="text-lf-danger"> · {failed.length} z błędem</span>} ·{" "}
            {plural(files.length, ["zmieniony plik", "zmienione pliki", "zmienionych plików"])}
          </span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={onlyCommands} onChange={(e) => setOnlyCommands(e.target.checked)} />
            Tylko polecenia
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showThinking} disabled={onlyCommands} onChange={(e) => setShowThinking(e.target.checked)} />
            Pokaż rozumowanie
          </label>
          {detail.skippedLines > 0 && <span title="Wiersze w nieznanym formacie zostały pominięte">
              pominięte: {plural(detail.skippedLines, ["wiersz", "wiersze", "wierszy"])}
            </span>}
        </div>
      </header>

      {files.length > 0 && !onlyCommands && (
        <section className="mx-5 mt-3 rounded border border-lf-border p-2" aria-label="Zmienione pliki">
          <p className="mb-1 text-[11px] font-semibold uppercase text-lf-muted">Zmienione pliki</p>
          <ul className="flex flex-col">
            {files.map((f) => (
              <li key={f} className="group flex items-center gap-2 font-mono text-xs text-lf-fg">
                <span className="codicon codicon-file text-lf-muted" aria-hidden />
                <span className="truncate" title={f}>
                  {f}
                </span>
                {!s.source.startsWith("ssh:") && (
                <button
                  type="button"
                  title="Otwórz w edytorze"
                  aria-label={`Otwórz ${f} w edytorze`}
                  onClick={() => openFile(logFilePath(f, s.cwd, s.source))}
                  className="hidden text-lf-muted hover:text-lf-fg group-focus-within:inline group-hover:inline"
                >
                  <span className="codicon codicon-go-to-file" aria-hidden />
                </button>
                )}
                <button type="button" title="Kopiuj ścieżkę" aria-label={`Kopiuj ścieżkę ${f}`} onClick={() => copy(f)} className="hidden text-lf-muted hover:text-lf-fg group-focus-within:inline group-hover:inline">
                  <span className="codicon codicon-copy" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ol className="flex flex-col gap-3 px-5 py-4" aria-label="Oś czasu">
        {visible.map((item, i) => (
          <TimelineRow key={i} item={item} source={s.source} cwd={s.cwd} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ item, source, cwd }: { item: TimelineItem; source: string; cwd: string | null }) {
  if (item.kind === "user") {
    return (
      <li className="ml-12 rounded-lg bg-lf-elevated px-3 py-2">
        <Meta label="Ty" ts={item.ts} />
        <p className="whitespace-pre-wrap break-words text-[13px] text-lf-fg">{item.text}</p>
      </li>
    );
  }
  if (item.kind === "assistant") {
    return (
      <li className="mr-12 px-1">
        <Meta label="Agent" ts={item.ts} />
        <p className="whitespace-pre-wrap break-words text-[13px] text-lf-fg">{item.text}</p>
      </li>
    );
  }
  if (item.kind === "thinking") {
    return (
      <li className="mr-12 border-l-2 border-lf-border px-3">
        <Meta label="Rozumowanie" ts={item.ts} />
        <p className="whitespace-pre-wrap break-words text-xs italic text-lf-muted">{item.text}</p>
      </li>
    );
  }
  const { call, result } = item;
  const isCommand = !!call.command;
  const failed = !!result?.isError;
  return (
    <li
      className={`rounded border ${failed ? "border-lf-danger/60" : "border-lf-border"} bg-lf-bg`}
      aria-label={isCommand ? `Polecenie ${call.command}` : `Narzędzie ${call.name}`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={`codicon codicon-${isCommand ? "terminal" : call.files.length ? "edit" : "tools"} text-lf-muted`} aria-hidden />
        <span className="shrink-0 text-[11px] text-lf-muted">{call.name}</span>
        <code className={`min-w-0 flex-1 truncate font-mono text-xs ${isCommand ? "text-lf-fg" : "text-lf-muted"}`} title={toolLabel(call)}>
          {toolLabel(call)}
        </code>
        {result?.exitCode != null && (
          <span className={`shrink-0 rounded px-1 text-[10px] ${result.exitCode === 0 ? "bg-lf-elevated text-lf-muted" : "bg-lf-danger/20 text-lf-danger"}`}>
            kod {result.exitCode}
          </span>
        )}
        {result?.isError && result.exitCode == null && <span className="shrink-0 text-[10px] text-lf-danger">błąd</span>}
        <span className="shrink-0 text-[10px] text-lf-subtle">{time(item.ts)}</span>
        {isCommand && (
          <>
            <IconButton icon="copy" label="Kopiuj polecenie" onClick={() => copy(call.command!)} />
            <IconButton
              icon="run"
              label="Wpisz w nowym terminalu (bez uruchamiania)"
              onClick={() => openCommandInTerminal({ command: call.command!, source, cwd, submit: false })}
            />
          </>
        )}
      </div>
      {result && result.output.trim() && (
        <details open={failed} className="border-t border-lf-border">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-lf-muted hover:text-lf-fg">Wynik</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11px] text-lf-fg">{result.output}</pre>
        </details>
      )}
      {!isCommand && call.files.length === 0 && call.input != null && (
        <details className="border-t border-lf-border">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-lf-muted hover:text-lf-fg">Parametry</summary>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11px] text-lf-muted">
            {typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function Meta({ label, ts }: { label: string; ts: number | null }) {
  return (
    <p className="mb-0.5 text-[10px] uppercase tracking-wide text-lf-subtle">
      {label} {ts ? `· ${time(ts)}` : ""}
    </p>
  );
}

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="shrink-0 rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg">
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
