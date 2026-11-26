import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/home/me/OneDrive/zadania" }));

import { TasksFoldersSettings } from "./TasksFolders";
import { useAgentsStore } from "../../store/agents";
import { useSettingsStore } from "../../store/settings";

let values: Record<string, unknown>;
let tasks: Record<string, unknown[]>;

describe("TasksFoldersSettings (#114)", () => {
  beforeEach(() => {
    values = {};
    tasks = { project: [], global: [] };
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
      switch (cmd) {
        case "settings_update":
          values = { ...values, [a.key as string]: a.value };
          return { path: "/c/settings.json", values, error: null };
        case "tasks_dir":
          return a.scope === "project" ? "/p/.leverframe/tasks" : "/data/tasks";
        case "tasks_list":
          return tasks[a.scope as string];
        case "tasks_adopt":
          return 2;
        default:
          return undefined;
      }
    });
    useSettingsStore.setState({ values: {} } as never);
    useAgentsStore.setState({ projectDir: "/p" } as never);
  });

  it("saves a new project folder at once when the old one has no tasks", async () => {
    render(<TasksFoldersSettings />);
    const field = screen.getByLabelText("Folder zadań w projekcie");
    expect(field).toHaveValue(".leverframe/tasks");
    fireEvent.change(field, { target: { value: "docs/zadania" } });
    fireEvent.blur(field);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_update", { key: "tasksProjectDir", value: "docs/zadania" }));
    expect(invoke).not.toHaveBeenCalledWith("tasks_adopt", expect.anything());
  });

  it("asks to move the tasks there are; moves them, or keeps the old folder on Anuluj", async () => {
    tasks.project = [{}, {}];
    render(<TasksFoldersSettings />);
    const field = screen.getByLabelText("Folder zadań w projekcie");
    fireEvent.change(field, { target: { value: ".zadania" } });
    fireEvent.blur(field);
    expect(await screen.findByRole("group", { name: "Przenieść zadania?" })).toHaveTextContent("(/p/.leverframe/tasks) jest zadań: 2");
    expect(invoke).not.toHaveBeenCalledWith("settings_update", expect.anything());
    fireEvent.click(screen.getByText("Anuluj"));
    expect(field).toHaveValue(".leverframe/tasks");

    fireEvent.change(field, { target: { value: ".zadania" } });
    fireEvent.blur(field);
    fireEvent.click(await screen.findByText("Przenieś"));
    expect(await screen.findByText("Przeniesiono zadania: 2.")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("settings_update", { key: "tasksProjectDir", value: ".zadania" });
    expect(invoke).toHaveBeenCalledWith("tasks_adopt", { scope: "project", from: "/p/.leverframe/tasks" });
  });

  it("chooses the global folder, goes back to the default one, and keeps the project out of git", async () => {
    render(<TasksFoldersSettings />);
    fireEvent.click(screen.getByText("Wybierz…"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_update", { key: "tasksGlobalDir", value: "/home/me/OneDrive/zadania" }));
    expect(await screen.findByLabelText("Folder zadań globalnych")).toHaveValue("/home/me/OneDrive/zadania");
    fireEvent.click(screen.getByText("Domyślny"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_update", { key: "tasksGlobalDir", value: "" }));
    const box = screen.getByRole("checkbox", { name: /Zadania projektu poza repozytorium/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_update", { key: "tasksExcludeFromGit", value: false }));
  });

  it("shows a refused folder", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "settings_update") throw "Folder zadań w projekcie: ścieżka względna";
      return cmd === "tasks_list" ? [] : "/p/.leverframe/tasks";
    });
    render(<TasksFoldersSettings />);
    const field = screen.getByLabelText("Folder zadań w projekcie");
    fireEvent.change(field, { target: { value: "../poza" } });
    fireEvent.blur(field);
    expect(await screen.findByRole("alert")).toHaveTextContent("ścieżka względna");
  });
});
