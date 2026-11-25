import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../lib/storage";
import type { TaskScope } from "../features/tasks/tasksClient";

interface TasksUiState {
  /** The list shown in the "Zadania" view (remembered). */
  scope: TaskScope;
  setScope: (scope: TaskScope) => void;
  /** Bumped by the "Zadania: nowe zadanie" command: the view opens its form. */
  newTaskRequest: number;
  requestNewTask: () => void;
}

export const useTasksStore = create<TasksUiState>()(
  persist(
    (set, get) => ({
      scope: "project",
      setScope: (scope) => set({ scope }),
      newTaskRequest: 0,
      requestNewTask: () => set({ newTaskRequest: get().newTaskRequest + 1 }),
    }),
    {
      name: "leverframe.tasks",
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ scope }) => ({ scope }),
    },
  ),
);
