import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { dockerClient } from "./dockerClient";

export interface ContainerLogsParams {
  container: string;
}

/** Shown while the container has written nothing to its log. */
export const NO_ENTRIES =
  "Brak wpisów w logu – kontener nic jeszcze nie wypisał; nowe wpisy pojawią się tutaj. Kontenery Leverframe tylko czekają (sleep infinity): wyjście agentów jest w ich terminalach.";

/** Lines kept in the panel. */
export const MAX_LOG_LINES = 5000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

/** A container's logs (`docker logs --follow`), followed while the tab is open. */
export function ContainerLogsPanel({ params }: IDockviewPanelProps<ContainerLogsParams>) {
  const [lines, setLines] = useState<string[]>([]);
  const [end, setEnd] = useState<{ ok: boolean; message: string | null } | null>(null);
  const [follow, setFollow] = useState(true);
  // `docker logs` runs: without lines yet the container has written nothing (not "loading").
  const [started, setStarted] = useState(false);
  const log = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let job: number | null = null;
    dockerClient
      .logs(params.container, (e) => {
        if (disposed) return;
        if (e.type === "line") setLines((l) => [...l, e.text.replace(ANSI, "")].slice(-MAX_LOG_LINES));
        else setEnd({ ok: e.ok, message: e.message });
      })
      .then(
        (id) => {
          job = id;
          if (disposed) void dockerClient.cancel(id);
          else setStarted(true);
        },
        (e: unknown) => !disposed && setEnd({ ok: false, message: String(e) }),
      );
    return () => {
      disposed = true;
      if (job !== null) void dockerClient.cancel(job);
    };
  }, [params.container]);

  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines, follow]);

  if (!isTauri()) return <Placeholder icon="output" title="Logi kontenera są dostępne w aplikacji desktopowej" />;
  return (
    <div className="flex h-full flex-col bg-lf-editor text-xs" data-testid="container-logs">
      <header className="flex shrink-0 items-center gap-2 border-b border-lf-border px-3 py-1.5">
        <span className="codicon codicon-output text-lf-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold text-lf-fg">Logi: {params.container}</span>
        <label className="flex items-center gap-1 text-lf-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Przewijaj do końca
        </label>
        <span role="status" className={end && !end.ok && end.message !== "Przerwano" ? "text-lf-danger" : "text-lf-muted"}>
          {end ? (end.ok ? "Kontener zakończył logi" : end.message) : "Na żywo"}
        </span>
      </header>
      <pre ref={log} aria-label="Logi" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] text-lf-fg">
        {lines.length ? lines.join("\n") : end ? "" : started ? <span className="text-lf-muted">{NO_ENTRIES}</span> : "Wczytywanie…"}
      </pre>
    </div>
  );
}
