import { invoke } from "@tauri-apps/api/core";

/** Where a task lives: the project's `.leverframe/tasks/` or the app's own tasks folder. */
export type TaskScope = "project" | "global";
export type TaskStatus = "todo" | "doing" | "review" | "done";

/** A task file (backend `tasks` module, #105). */
export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  created: string;
  /** File name in the scope's folder – names the task in the commands. */
  file: string;
  path: string;
  scope: TaskScope;
  /** Agents started on the task, oldest first (#109). */
  runs: TaskRun[];
}

export type RunMode = "chat" | "terminal";

/** One start of an agent on a task (the header's `runs`). */
export interface TaskRun {
  /** ISO 8601. */
  at: string;
  agent: string;
  /** Profile id ("" – the default profile). */
  profile: string;
  mode: RunMode;
  cwd?: string | null;
  /** The task's copy on the agent's computer (SSH, container without the folder). */
  remote?: string | null;
}

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "Do zrobienia" },
  { id: "doing", label: "W toku" },
  { id: "review", label: "Do sprawdzenia" },
  { id: "done", label: "Gotowe" },
];

export const statusLabel = (s: TaskStatus) => STATUSES.find((x) => x.id === s)?.label ?? s;

export const tasksClient = {
  list: (scope: TaskScope) => invoke<Task[]>("tasks_list", { scope }),
  dir: (scope: TaskScope) => invoke<string>("tasks_dir", { scope }),
  create: (scope: TaskScope, title: string) => invoke<Task>("tasks_create", { scope, title }),
  update: (scope: TaskScope, file: string, change: { title?: string; status?: TaskStatus }) =>
    invoke<Task>("tasks_update", { scope, file, change }),
  move: (scope: TaskScope, file: string, to: TaskScope) => invoke<Task>("tasks_move", { scope, file, to }),
  remove: (scope: TaskScope, file: string, permanently: boolean) => invoke<void>("tasks_delete", { scope, file, permanently }),
  addRun: (scope: TaskScope, file: string, run: TaskRun) => invoke<Task>("tasks_add_run", { scope, file, run }),
  /** Copies the task to `<dir>/.leverframe/tasks/` on a profile's computer; the path there. */
  copyTo: (scope: TaskScope, file: string, profileId: string, dir: string) =>
    invoke<string>("tasks_copy_to", { scope, file, profileId, dir }),
  readRemote: (profileId: string, path: string) => invoke<string>("tasks_read_remote", { profileId, path }),
};
