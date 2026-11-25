import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAgentsStore } from "../../store/agents";
import { editorForPath } from "../../store/editor";
import { useProfilesStore } from "../../store/profiles";
import { useTasksStore } from "../../store/tasks";
import { useTerminalStore } from "../../store/terminal";
import { notifyFilesChanged } from "../../lib/fileEvents";
import { openAgentChatHistory, openChatPanel, openDiff, openSessionPlayer, revealTerminal } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { errorMessage, fsClient } from "../editor/fsClient";
import { sessionsClient, type SessionRecord } from "../sessions/sessionsClient";
import { liveKey, startTaskRun } from "./taskRun";
import { tasksClient, type RunMode, type Task, type TaskRun } from "./tasksClient";

const button = "rounded px-2 py-0.5 text-[11px] disabled:opacity-50";
const field = "w-full rounded border border-lf-border bg-lf-bg px-1.5 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent";

/** "Uruchom agenta…" of a task (#107, #108): agent, profile, mode and the folder to work in. */
export function RunTaskForm(props: { task: Task; onStarted: () => void; onCancel: () => void }) {
  const { task } = props;
  const agents = useAgentsStore((s) => s.agents).filter((a) => !a.hidden);
  const projectDir = useAgentsStore((s) => s.projectDir);
  const recentDirs = useAgentsStore((s) => s.recentDirs);
  const remoteDirs = useAgentsStore((s) => s.remoteDirs);
  const chosenProfile = useAgentsStore((s) => s.profileId);
  const profiles = useProfilesStore((s) => s.profiles);
  const defaultProfileId = useProfilesStore((s) => s.defaultProfileId);
  const last = task.runs.at(-1);
  const [agentId, setAgentId] = useState(last?.agent ?? agents[0]?.id ?? "");
  const [profileId, setProfileId] = useState(last?.profile || chosenProfile || defaultProfileId || profiles[0]?.id || "");
  const agent = agents.find((a) => a.id === agentId);
  const canChat = !!agent?.acp;
  const canTerminal = agent?.promptArg != null;
  const [mode, setMode] = useState<RunMode>(last?.mode ?? "chat");
  const effectiveMode: RunMode = mode === "chat" ? (canChat ? "chat" : "terminal") : canTerminal ? "terminal" : "chat";
  const profile = profiles.find((p) => p.id === profileId);
  const [dir, setDir] = useState<string>((task.scope === "global" && last?.cwd) || projectDir || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folders = [...new Set([dir, projectDir, ...recentDirs].filter((d): d is string => !!d))];
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startTaskRun({ task, agentId, profileId: profileId || null, mode: effectiveMode, cwd: task.scope === "project" ? projectDir : dir || null });
      props.onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dir || undefined });
    if (typeof picked === "string") setDir(picked);
  };

  return (
    <div role="group" aria-label={`Uruchom agenta: zadanie #${task.id}`} className="mb-1 ml-4 flex flex-col gap-1.5 rounded border border-lf-border bg-lf-editor p-2 text-[11px] text-lf-muted">
      <label>
        Agent
        <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={field}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Profil
        <select aria-label="Profil" value={profileId} onChange={(e) => setProfileId(e.target.value)} className={field}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div role="radiogroup" aria-label="Tryb" className="flex gap-3">
        <label className={canChat ? "" : "opacity-50"}>
          <input type="radio" name={`mode-${task.file}`} checked={effectiveMode === "chat"} disabled={!canChat} onChange={() => setMode("chat")} /> Rozmowa
        </label>
        <label className={canTerminal ? "" : "opacity-50"} title={canTerminal ? undefined : "Ten agent nie przyjmuje polecenia przy starcie w terminalu"}>
          <input type="radio" name={`mode-${task.file}`} checked={effectiveMode === "terminal"} disabled={!canTerminal} onChange={() => setMode("terminal")} /> Terminal
        </label>
      </div>
      {profile?.kind === "ssh" ? (
        <p>
          Folder na serwerze: <span className="font-mono text-lf-fg">{remoteDirs[profile.id] || "~"}</span> (zmienisz go w widoku „Agenci”). Plik zadania
          zostanie tam skopiowany.
        </p>
      ) : task.scope === "project" ? (
        <p title={projectDir ?? undefined}>
          Folder: <span className="text-lf-fg">{projectDir ? folderName(projectDir) : "–"}</span>
          {profile?.kind === "container" && " (w kontenerze: jego folder projektu; bez montowania plik zadania zostanie skopiowany)"}
        </p>
      ) : (
        <label>
          Folder pracy
          <div className="flex gap-1">
            <select aria-label="Folder pracy" value={dir} onChange={(e) => setDir(e.target.value)} className={field}>
              {folders.length === 0 && <option value="">(wybierz folder)</option>}
              {folders.map((d) => (
                <option key={d} value={d} title={d}>
                  {folderName(d)} – {d}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void pick()} className={`${button} border border-lf-border text-lf-fg`}>
              Wybierz…
            </button>
          </div>
        </label>
      )}
      {!canChat && !canTerminal && agent && <p className="text-lf-danger">{agent.name} nie ma trybu rozmowy ani polecenia startowego.</p>}
      {error && (
        <p role="alert" className="text-lf-danger">
          {error}
        </p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy || !agent || (!canChat && !canTerminal) || (task.scope === "global" && profile?.kind !== "ssh" && !dir)}
          onClick={() => void start()}
          className={`${button} bg-lf-accent text-lf-accent-fg`}
        >
          {busy ? "Uruchamianie…" : "Uruchom"}
        </button>
        <button type="button" onClick={props.onCancel} className={`${button} text-lf-muted hover:text-lf-fg`}>
          Anuluj
        </button>
      </div>
    </div>
  );
}

/** The recording of a run in the history: the agent's session that started closest after it. */
export function recordForRun(records: SessionRecord[], run: TaskRun): SessionRecord | undefined {
  const at = Date.parse(run.at);
  return records
    .filter((r) => r.agentId === run.agent && r.startedAt >= at - 5_000 && r.startedAt <= at + 10 * 60_000)
    .sort((a, b) => a.startedAt - b.startedAt)[0];
}

/** "Uruchomienia" of a task (#109): live ones open their tab, ended ones the history. */
export function TaskRunsList(props: { task: Task }) {
  const { task } = props;
  const live = useTasksStore((s) => s.live);
  const terminals = useTerminalStore((s) => s.running);
  const agentName = useAgentsStore((s) => s.agentById);
  const profiles = useProfilesStore((s) => s.profiles);
  const [message, setMessage] = useState<string | null>(null);
  const [fetched, setFetched] = useState<{ text: string; mtime: number } | null>(null);

  const open = async (run: TaskRun) => {
    setMessage(null);
    const now = live[liveKey(task.path, run.at)];
    if (now) {
      if (now.mode === "chat") openChatPanel(now.target);
      else revealTerminal(now.target, terminals.find((t) => t.panelId === now.target)?.dock ?? "panel");
      return;
    }
    try {
      const records = await sessionsClient.list({ kind: run.mode === "chat" ? "acp" : "terminal", agentId: run.agent, from: Date.parse(run.at) - 5_000, limit: 50 });
      const record = recordForRun(records, run);
      if (!record) setMessage("Brak zapisu tego uruchomienia w historii sesji (nagrywanie może być wyłączone).");
      else if (run.mode === "chat") openAgentChatHistory(record);
      else openSessionPlayer(record);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  // "Pobierz wynik": the copy on the agent's computer, compared with the task first.
  const fetchResult = async (run: TaskRun) => {
    setMessage(null);
    setFetched(null);
    try {
      const [remote, local] = await Promise.all([
        tasksClient.readRemote(run.profile, run.remote!),
        fsClient.readText(task.path),
      ]);
      if (remote.replace(/\n$/, "") === local.content.replace(/\n$/, "")) {
        setMessage("Kopia na komputerze agenta nie różni się od zadania.");
        return;
      }
      openDiff({ path: task.path, oldText: local.content, newText: remote });
      setFetched({ text: remote, mtime: local.mtime });
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };
  const saveResult = async () => {
    if (!fetched) return;
    try {
      await fsClient.writeText(task.path, fetched.text, fetched.mtime);
      setFetched(null);
      setMessage("Zapisano wynik w pliku zadania.");
      const editor = editorForPath(task.path);
      if (editor && !editor.dirty) void editor.reload?.().catch(() => undefined);
      notifyFilesChanged([task.path]);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  const modeLabel = (m: RunMode) => (m === "chat" ? "rozmowa" : "terminal");
  return (
    <div role="group" aria-label={`Uruchomienia zadania #${task.id}`} className="mb-1 ml-4 flex flex-col gap-0.5 text-[11px]">
      {task.runs.length === 0 && <p className="text-lf-subtle">Jeszcze nie uruchamiano agenta.</p>}
      <ul aria-label="Uruchomienia" className="flex flex-col">
        {[...task.runs].reverse().map((run) => {
          const running = !!live[liveKey(task.path, run.at)];
          const profile = profiles.find((p) => p.id === run.profile)?.name ?? (run.profile || "profil domyślny");
          return (
            <li key={run.at} className="flex items-center gap-1">
              <button type="button" onClick={() => void open(run)} className="flex min-w-0 flex-1 items-baseline gap-1 rounded px-1 text-left text-lf-fg hover:bg-lf-hover" title={run.cwd ?? undefined}>
                <span className="shrink-0 text-lf-subtle">{new Date(run.at).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="truncate">
                  {agentName(run.agent)?.name ?? run.agent} · {profile} · {modeLabel(run.mode)}
                </span>
                {running && <span className="shrink-0 rounded bg-lf-accent px-1 text-[10px] text-lf-accent-fg">trwa</span>}
              </button>
              {run.remote && (
                <button type="button" onClick={() => void fetchResult(run)} title={run.remote} className={`${button} shrink-0 border border-lf-border text-lf-fg`}>
                  Pobierz wynik
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {fetched && (
        <div role="group" aria-label="Wynik z komputera agenta" className="flex flex-wrap items-center gap-1 pt-1">
          <span className="text-lf-fg">Zmiany pokazano obok. Zastąpić plik zadania kopią agenta?</span>
          <button type="button" onClick={() => void saveResult()} className={`${button} bg-lf-accent text-lf-accent-fg`}>
            Zapisz w zadaniu
          </button>
          <button type="button" onClick={() => setFetched(null)} className={`${button} text-lf-muted hover:text-lf-fg`}>
            Anuluj
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="text-lf-muted">
          {message}
        </p>
      )}
    </div>
  );
}
