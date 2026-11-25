import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../lib/storage";
import { tasksClient, type RunMode, type TaskScope } from "../features/tasks/tasksClient";
import { useAgentsStore } from "./agents";

/** A run of an agent on a task still going on in this window (#109). */
export interface LiveRun {
  /** `<task path>|<run start>`. */
  key: string;
  scope: TaskScope;
  file: string;
  path: string;
  mode: RunMode;
  /** The conversation's id or the terminal's panel id. */
  target: string;
  /** The conversation was busy with the task (its end is the run's end). */
  sawBusy: boolean;
  /** The terminal's tab was seen (gone after that: the run ended). */
  seen: boolean;
}

interface TasksUiState {
  /** The list shown in the "Zadania" view (remembered). */
  scope: TaskScope;
  setScope: (scope: TaskScope) => void;
  /** Bumped by the "Zadania: nowe zadanie" command: the view opens its form. */
  newTaskRequest: number;
  requestNewTask: () => void;
  /** Tasks „Do sprawdzenia” per list (the count on the activity bar). */
  review: Record<TaskScope, number>;
  setReview: (scope: TaskScope, count: number) => void;
  live: Record<string, LiveRun>;
  addLive: (run: LiveRun) => void;
  updateLive: (key: string, change: Partial<LiveRun>) => void;
  removeLive: (key: string) => void;
}

export const useTasksStore = create<TasksUiState>()(
  persist(
    (set, get) => ({
      scope: "project",
      setScope: (scope) => set({ scope }),
      newTaskRequest: 0,
      requestNewTask: () => set({ newTaskRequest: get().newTaskRequest + 1 }),
      review: { project: 0, global: 0 },
      setReview: (scope, count) => {
        if (get().review[scope] !== count) set({ review: { ...get().review, [scope]: count } });
      },
      live: {},
      addLive: (run) => set({ live: { ...get().live, [run.key]: run } }),
      updateLive: (key, change) => {
        const run = get().live[key];
        if (run) set({ live: { ...get().live, [key]: { ...run, ...change } } });
      },
      removeLive: (key) => {
        if (!get().live[key]) return;
        const live = { ...get().live };
        delete live[key];
        set({ live });
      },
    }),
    {
      name: "leverframe.tasks",
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ scope }) => ({ scope }),
    },
  ),
);

/** Counts the tasks „Do sprawdzenia” of both lists again (the project's only with a project folder). */
export async function refreshTaskCounts() {
  const { setReview } = useTasksStore.getState();
  const scopes: TaskScope[] = useAgentsStore.getState().projectDir ? ["project", "global"] : ["global"];
  if (!useAgentsStore.getState().projectDir) setReview("project", 0);
  await Promise.all(
    scopes.map((s) =>
      tasksClient.list(s).then(
        (tasks) => setReview(s, tasks.filter((t) => t.status === "review").length),
        () => undefined,
      ),
    ),
  );
}
