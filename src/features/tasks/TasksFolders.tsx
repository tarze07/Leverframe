import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { notifyFilesChanged } from "../../lib/fileEvents";
import { useAgentsStore } from "../../store/agents";
import { useSettingsStore } from "../../store/settings";
import { refreshTaskCounts } from "../../store/tasks";
import { errorMessage } from "../editor/fsClient";
import { tasksClient, type TaskScope } from "./tasksClient";

export const DEFAULT_PROJECT_TASKS_DIR = ".leverframe/tasks";

const input = "w-full rounded border border-lf-border bg-lf-bg px-1.5 py-1 font-mono text-xs text-lf-fg outline-none focus:border-lf-accent";
const button = "rounded px-2 py-0.5 text-[11px] disabled:opacity-50";

interface Pending {
  scope: TaskScope;
  key: "tasksProjectDir" | "tasksGlobalDir";
  value: string;
  from: string;
  count: number;
}

/**
 * Where the tasks live (#114): the folder in the project (relative), the folder of the global
 * tasks (anywhere) and whether the project's folder stays out of git. A changed folder that had
 * tasks asks whether to move them; nothing is overwritten.
 */
export function TasksFoldersSettings() {
  const values = useSettingsStore((s) => s.values);
  const update = useSettingsStore((s) => s.update);
  const projectDir = useAgentsStore((s) => s.projectDir);
  const savedProject = typeof values.tasksProjectDir === "string" ? values.tasksProjectDir : "";
  const savedGlobal = typeof values.tasksGlobalDir === "string" ? values.tasksGlobalDir : "";
  const exclude = values.tasksExcludeFromGit !== false;
  const [project, setProject] = useState(savedProject || DEFAULT_PROJECT_TASKS_DIR);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (key: Pending["key"], value: string) => {
    const err = await update(key, value);
    if (err) throw new Error(err);
  };

  // Before a folder changes: its tasks now (the old folder) – asked about when there are some.
  const change = async (scope: TaskScope, key: Pending["key"], value: string) => {
    setError(null);
    setMessage(null);
    try {
      const has = scope === "global" || !!projectDir;
      const [from, tasks] = has ? await Promise.all([tasksClient.dir(scope), tasksClient.list(scope)]) : ["", []];
      if (tasks.length > 0) {
        setPending({ scope, key, value, from, count: tasks.length });
        return;
      }
      await save(key, value);
      done();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const done = () => {
    notifyFilesChanged([]);
    void refreshTaskCounts();
  };

  const decide = async (move: boolean) => {
    if (!pending) return;
    setError(null);
    try {
      await save(pending.key, pending.value);
      if (move) {
        const moved = await tasksClient.adopt(pending.scope, pending.from);
        setMessage(`Przeniesiono zadania: ${moved}.`);
      }
      setPending(null);
      done();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const cancel = () => {
    if (pending?.key === "tasksProjectDir") setProject(savedProject || DEFAULT_PROJECT_TASKS_DIR);
    setPending(null);
  };

  const pickGlobal = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: savedGlobal || undefined });
    if (typeof picked === "string" && picked !== savedGlobal) await change("global", "tasksGlobalDir", picked);
  };

  return (
    <div role="group" aria-label="Foldery zadań" className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs font-semibold text-lf-fg">
        Zadania: folder w projekcie
        <input
          aria-label="Folder zadań w projekcie"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          onBlur={() => {
            const v = project.trim() === DEFAULT_PROJECT_TASKS_DIR ? "" : project.trim();
            if (v !== savedProject) void change("project", "tasksProjectDir", v);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder={DEFAULT_PROJECT_TASKS_DIR}
          spellCheck={false}
          className={input}
        />
        <span className="text-[11px] font-normal text-lf-subtle">Ścieżka względna wewnątrz folderu projektu, np. docs/zadania.</span>
      </label>
      <div className="flex flex-col gap-1 text-xs font-semibold text-lf-fg">
        Zadania: folder zadań globalnych
        <div className="flex gap-1">
          <input aria-label="Folder zadań globalnych" readOnly value={savedGlobal} placeholder="(domyślny – w danych aplikacji)" className={input} />
          <button type="button" onClick={() => void pickGlobal()} className={`${button} shrink-0 border border-lf-border text-lf-fg`}>
            Wybierz…
          </button>
          {savedGlobal && (
            <button type="button" onClick={() => void change("global", "tasksGlobalDir", "")} className={`${button} shrink-0 text-lf-muted hover:text-lf-fg`}>
              Domyślny
            </button>
          )}
        </div>
        <span className="text-[11px] font-normal text-lf-subtle">Np. folder w OneDrive albo w repozytorium z notatkami.</span>
      </div>
      <label className="flex items-start gap-2 text-xs text-lf-fg">
        <input type="checkbox" checked={exclude} onChange={(e) => void update("tasksExcludeFromGit", e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-semibold">Zadania projektu poza repozytorium</span>
          <span className="block text-[11px] text-lf-subtle">Folder zadań trafia do .git/info/exclude (.gitignore zostaje bez zmian).</span>
        </span>
      </label>
      {pending && (
        <div role="group" aria-label="Przenieść zadania?" className="flex flex-col gap-1 rounded border border-lf-border bg-lf-editor p-2 text-[11px] text-lf-fg">
          <span>
            W dotychczasowym folderze ({pending.from}) jest zadań: {pending.count}. Przenieść je do nowego folderu? Nic nie zostanie nadpisane.
          </span>
          <div className="flex gap-1">
            <button type="button" onClick={() => void decide(true)} className={`${button} bg-lf-accent text-lf-accent-fg`}>
              Przenieś
            </button>
            <button type="button" onClick={() => void decide(false)} className={`${button} border border-lf-border`}>
              Zostaw
            </button>
            <button type="button" onClick={cancel} className={`${button} text-lf-muted hover:text-lf-fg`}>
              Anuluj
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-[11px] text-lf-muted">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-lf-danger">
          {error}
        </p>
      )}
    </div>
  );
}
