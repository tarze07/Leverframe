import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { onFilesChanged } from "../../lib/fileEvents";
import { useAgentsStore } from "../../store/agents";
import { refreshTaskCounts, useTasksStore } from "../../store/tasks";
import { closeEditorsUnder, openFile } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { errorMessage } from "../editor/fsClient";
import { RunTaskForm, TaskRunsList } from "./TaskRuns";
import { STATUSES, statusLabel, tasksClient, type Task, type TaskScope, type TaskStatus } from "./tasksClient";

const SCOPES: { id: TaskScope; label: string }[] = [
  { id: "project", label: "Projekt" },
  { id: "global", label: "Globalne" },
];

/**
 * Sidebar view: the task list (#106) of the project (`.leverframe/tasks/`) or the global one.
 * Tasks are Markdown files – a click opens one in the editor; the menu changes its status, moves
 * it to the other list or deletes it.
 */
export function TasksView() {
  const scope = useTasksStore((s) => s.scope);
  const setScope = useTasksStore((s) => s.setScope);
  const newTaskRequest = useTasksStore((s) => s.newTaskRequest);
  const projectDir = useAgentsStore((s) => s.projectDir);
  const loadAgents = useAgentsStore((s) => s.load);
  const setProjectDir = useAgentsStore((s) => s.setProjectDir);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set(["done"]));
  const [menu, setMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const noProject = scope === "project" && !projectDir;
  // Only the latest listing is shown: one of the other list (or folder) may answer later.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (scope === "project" && !projectDir) return;
    const request = ++latest.current;
    try {
      const list = await tasksClient.list(scope);
      if (request !== latest.current) return;
      setTasks(list);
      setError(null);
    } catch (e) {
      if (request === latest.current) setError(errorMessage(e));
    }
  }, [scope, projectDir]);

  useEffect(() => {
    if (scope === "project" && !projectDir) return;
    const request = ++latest.current;
    const live = () => request === latest.current;
    tasksClient.list(scope).then(
      (list) => {
        if (!live()) return;
        setTasks(list);
        setError(null);
      },
      (e: unknown) => live() && setError(errorMessage(e)),
    );
  }, [scope, projectDir]);

  // A task saved in the editor (or written by an agent) shows its new title and status.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => onFilesChanged(() => void reloadRef.current()), []);

  // "Zadania: nowe zadanie" from the command palette.
  const seenRequest = useRef(newTaskRequest);
  useEffect(() => {
    if (newTaskRequest === seenRequest.current) return;
    seenRequest.current = newTaskRequest;
    setCreating(true);
  }, [newTaskRequest]);

  if (!isTauri()) {
    return <Placeholder icon="tasklist" title="Zadania" children="Lista zadań jest dostępna w aplikacji desktopowej." />;
  }

  const act = async (what: () => Promise<unknown>) => {
    setError(null);
    try {
      await what();
      setMenu(null);
      setDeleting(null);
      await reload();
      void refreshTaskCounts();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const create = (title: string) =>
    act(async () => {
      const task = await tasksClient.create(scope, title);
      setCreating(false);
      openFile(task.path);
    });
  const setStatus = (t: Task, status: TaskStatus) => act(() => tasksClient.update(t.scope, t.file, { status }));
  const move = (t: Task) =>
    act(async () => {
      await tasksClient.move(t.scope, t.file, t.scope === "project" ? "global" : "project");
      closeEditorsUnder(t.path);
    });
  const remove = (t: Task, permanently: boolean) =>
    act(async () => {
      await tasksClient.remove(t.scope, t.file, permanently);
      closeEditorsUnder(t.path);
    });

  const pickFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") await setProjectDir(picked);
  };

  const query = filter.trim().toLowerCase();
  const shown = (tasks ?? []).filter((t) => !query || t.title.toLowerCase().includes(query) || String(t.id) === query.replace(/^#/, ""));

  return (
    <div className="flex flex-col gap-2 px-3 pb-4">
      <div className="flex items-center gap-1">
        <div role="group" aria-label="Lista zadań" className="flex rounded border border-lf-border text-[11px]">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={scope === s.id}
              onClick={() => {
                if (s.id === scope) return;
                setScope(s.id);
                setTasks(null);
                setMenu(null);
                setDeleting(null);
                setError(null);
              }}
              className={`px-2 py-0.5 ${scope === s.id ? "bg-lf-accent text-lf-accent-fg" : "text-lf-muted hover:text-lf-fg"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-[11px] text-lf-subtle" title={scope === "project" ? (projectDir ?? undefined) : undefined}>
          {scope === "project" ? (projectDir ? folderName(projectDir) : "") : "wszystkie projekty"}
        </span>
        <ToolbarButton icon="add" label="Nowe zadanie…" disabled={noProject} onClick={() => (setCreating(true), setError(null))} />
        <ToolbarButton icon="refresh" label="Odśwież" disabled={noProject} onClick={() => void reload()} />
      </div>

      {noProject ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-xs text-lf-muted">Nie wybrano folderu projektu. Zadania projektu są w jego folderze .leverframe/tasks.</p>
          <button type="button" onClick={() => void pickFolder()} className="rounded bg-lf-accent px-3 py-1 text-xs text-lf-accent-fg">
            Otwórz folder…
          </button>
        </div>
      ) : (
        <>
          {creating && <NewTaskForm onSubmit={(t) => void create(t)} onCancel={() => setCreating(false)} />}
          <input
            aria-label="Filtruj zadania"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtruj po tytule lub #numerze"
            className="rounded border border-lf-border bg-lf-bg px-1.5 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent"
          />
          {error && (
            <p role="alert" className="text-[11px] text-lf-danger">
              {error}
            </p>
          )}
          {tasks === null && !error && <p className="text-[11px] text-lf-subtle">Wczytywanie…</p>}
          {tasks?.length === 0 && !creating && (
            <p className="text-[11px] text-lf-subtle">
              Brak zadań. Kliknij <span className="codicon codicon-add align-middle" aria-hidden /> „Nowe zadanie…”.
            </p>
          )}
          {tasks &&
            tasks.length > 0 &&
            STATUSES.map((s) => {
              const group = shown.filter((t) => t.status === s.id);
              const isCollapsed = collapsed.has(s.id);
              return (
                <section key={s.id} aria-label={s.label}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-lf-muted hover:text-lf-fg"
                  >
                    <span className={`codicon codicon-chevron-${isCollapsed ? "right" : "down"}`} aria-hidden />
                    {s.label}
                    <span className="ml-auto rounded-full bg-lf-hover px-1.5 text-[10px] font-normal">{group.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul aria-label={`Zadania: ${s.label}`} className="mt-0.5 flex flex-col">
                      {group.map((t) => (
                        <TaskItem
                          key={t.file}
                          task={t}
                          menuOpen={menu === t.file}
                          deleting={deleting === t.file}
                          onMenu={(open) => (setMenu(open ? t.file : null), setDeleting(null))}
                          onStatus={(st) => void setStatus(t, st)}
                          onMove={() => void move(t)}
                          onDelete={() => (setDeleting(t.file), setMenu(null))}
                          onConfirmDelete={(permanently) => void remove(t, permanently)}
                          onCancelDelete={() => setDeleting(null)}
                          onStarted={() => void reload()}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
        </>
      )}
    </div>
  );
}

function TaskItem(props: {
  task: Task;
  menuOpen: boolean;
  deleting: boolean;
  onMenu: (open: boolean) => void;
  onStatus: (s: TaskStatus) => void;
  onMove: () => void;
  onDelete: () => void;
  onConfirmDelete: (permanently: boolean) => void;
  onCancelDelete: () => void;
  onStarted: () => void;
}) {
  const t = props.task;
  const [panel, setPanel] = useState<"run" | "runs" | null>(null);
  const running = useTasksStore((s) => Object.values(s.live).some((r) => r.path === t.path));
  const toggle = (p: "run" | "runs") => setPanel((now) => (now === p ? null : p));
  const item = "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-lf-fg hover:bg-lf-hover";
  return (
    <li aria-label={`#${t.id} ${t.title}`}>
      <div
        className="group flex items-center rounded hover:bg-lf-hover"
        onContextMenu={(e) => {
          e.preventDefault();
          props.onMenu(true);
        }}
      >
        <button
          type="button"
          onClick={() => openFile(t.path)}
          title={`${t.path}\n${statusLabel(t.status)}${t.created ? ` · utworzone ${t.created}` : ""}`}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 pl-4 text-left text-[13px] text-lf-fg"
        >
          <span className="shrink-0 font-mono text-[11px] text-lf-subtle">#{t.id}</span>
          <span className={`truncate ${t.status === "done" ? "text-lf-muted line-through" : ""}`}>{t.title}</span>
          {running && <span className="codicon codicon-loading codicon-modifier-spin shrink-0 text-lf-accent" title="Agent pracuje nad zadaniem" aria-label="trwa" />}
        </button>
        {t.runs.length > 0 && (
          <button
            type="button"
            title="Uruchomienia"
            aria-label={`Uruchomienia: ${t.title}`}
            aria-expanded={panel === "runs"}
            onClick={() => toggle("runs")}
            className="shrink-0 rounded px-1 text-[10px] text-lf-subtle hover:text-lf-fg"
          >
            <span className="codicon codicon-history align-middle" aria-hidden /> {t.runs.length}
          </button>
        )}
        <button
          type="button"
          title="Uruchom agenta…"
          aria-label={`Uruchom agenta: ${t.title}`}
          aria-expanded={panel === "run"}
          onClick={() => toggle("run")}
          className="shrink-0 rounded p-0.5 text-lf-muted opacity-0 hover:text-lf-fg focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        >
          <span className="codicon codicon-play" aria-hidden />
        </button>
        <button
          type="button"
          title="Więcej"
          aria-label={`Więcej: ${t.title}`}
          aria-expanded={props.menuOpen}
          onClick={() => props.onMenu(!props.menuOpen)}
          className="mr-1 shrink-0 rounded p-0.5 text-lf-muted opacity-0 hover:text-lf-fg focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        >
          <span className="codicon codicon-kebab-vertical" aria-hidden />
        </button>
      </div>
      {props.menuOpen && (
        <div role="menu" aria-label={`Zadanie #${t.id}`} className="mb-1 ml-4 flex flex-col rounded border border-lf-border bg-lf-editor p-1">
          {STATUSES.filter((s) => s.id !== t.status).map((s) => (
            <button key={s.id} type="button" role="menuitem" onClick={() => props.onStatus(s.id)} className={item}>
              <span className="codicon codicon-arrow-right text-lf-muted" aria-hidden />
              {s.label}
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => (setPanel("run"), props.onMenu(false))} className={item}>
            <span className="codicon codicon-play text-lf-muted" aria-hidden />
            Uruchom agenta…
          </button>
          <button type="button" role="menuitem" onClick={props.onMove} className={item}>
            <span className="codicon codicon-move text-lf-muted" aria-hidden />
            {t.scope === "project" ? "Przenieś do globalnych" : "Przenieś do projektu"}
          </button>
          <button type="button" role="menuitem" onClick={props.onDelete} className={`${item} text-lf-danger`}>
            <span className="codicon codicon-trash" aria-hidden />
            Usuń…
          </button>
          <button type="button" role="menuitem" onClick={() => props.onMenu(false)} className={`${item} text-lf-muted`}>
            Anuluj
          </button>
        </div>
      )}
      {panel === "run" && <RunTaskForm task={t} onStarted={() => (setPanel(null), props.onStarted())} onCancel={() => setPanel(null)} />}
      {panel === "runs" && <TaskRunsList task={t} />}
      {props.deleting && (
        <div role="group" aria-label={`Usuwanie zadania #${t.id}`} className="flex flex-wrap items-center gap-1 py-1 pl-4 text-[11px]">
          <span className="text-lf-fg">Usunąć zadanie „{t.title}”?</span>
          <button type="button" onClick={() => props.onConfirmDelete(false)} className="rounded bg-lf-danger px-2 py-0.5 text-white">
            Do kosza
          </button>
          <button type="button" onClick={() => props.onConfirmDelete(true)} className="rounded border border-lf-danger px-2 py-0.5 text-lf-danger">
            Usuń na stałe
          </button>
          <button type="button" onClick={props.onCancelDelete} className="px-1 text-lf-muted hover:text-lf-fg">
            Anuluj
          </button>
        </div>
      )}
    </li>
  );
}

/** The title of a new task; Enter creates it, Escape cancels. */
function NewTaskForm(props: { onSubmit: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      aria-label="Nowe zadanie"
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) props.onSubmit(title.trim());
      }}
    >
      <label className="text-[11px] text-lf-muted">
        Tytuł nowego zadania
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
          placeholder="np. Dodać eksport do CSV"
          className="mt-0.5 w-full rounded border border-lf-border bg-lf-bg px-1.5 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent"
        />
      </label>
      <div className="flex gap-1">
        <button type="submit" disabled={!title.trim()} className="rounded bg-lf-accent px-2 py-0.5 text-[11px] text-lf-accent-fg disabled:opacity-50">
          Utwórz
        </button>
        <button type="button" onClick={props.onCancel} className="rounded px-2 py-0.5 text-[11px] text-lf-muted hover:text-lf-fg">
          Anuluj
        </button>
      </div>
    </form>
  );
}

function ToolbarButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg disabled:opacity-40"
    >
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
