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
};
