import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
const openFile = vi.fn();
const closeEditorsUnder = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openFile: (...a: unknown[]) => openFile(...a),
  closeEditorsUnder: (...a: unknown[]) => closeEditorsUnder(...a),
}));

import { TasksView } from "./TasksView";
import type { Task, TaskScope } from "./tasksClient";
import { useAgentsStore } from "../../store/agents";
import { useTasksStore } from "../../store/tasks";
import { notifyFilesChanged } from "../../lib/fileEvents";

let db: Record<TaskScope, Task[]>;
const dir = (scope: TaskScope) => (scope === "project" ? "/p/.leverframe/tasks" : "/data/tasks");
const task = (scope: TaskScope, id: number, title: string, status: Task["status"] = "todo"): Task => ({
  id,
  title,
  status,
  created: "2026-11-25",
  file: `${id}-${title.toLowerCase().replace(/\W+/g, "-")}.md`,
  path: `${dir(scope)}/${id}-${title.toLowerCase().replace(/\W+/g, "-")}.md`,
  scope,
  runs: [],
});

describe("TasksView (#106)", () => {
  beforeEach(() => {
    db = {
      project: [task("project", 1, "Eksport CSV"), task("project", 2, "Logowanie", "doing"), task("project", 3, "Stare", "done")],
      global: [task("global", 1, "Wspólne narzędzia")],
    };
    invoke.mockReset();
    openFile.mockReset();
    closeEditorsUnder.mockReset();
    invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
      const scope = a?.scope as TaskScope;
      switch (cmd) {
        case "tasks_list":
          return db[scope].map((t) => ({ ...t }));
        case "tasks_create": {
          if (!(a.title as string).trim()) throw "Podaj tytuł zadania";
          const t = task(scope, Math.max(0, ...db[scope].map((x) => x.id)) + 1, a.title as string);
          db[scope].push(t);
          return t;
        }
        case "tasks_update": {
          const t = db[scope].find((x) => x.file === a.file)!;
          Object.assign(t, a.change);
          return t;
        }
        case "tasks_move": {
          const to = a.to as TaskScope;
          const t = db[scope].find((x) => x.file === a.file)!;
          db[scope] = db[scope].filter((x) => x !== t);
          const moved = task(to, Math.max(0, ...db[to].map((x) => x.id)) + 1, t.title, t.status);
          db[to].push(moved);
          return moved;
        }
        case "tasks_delete":
          db[scope] = db[scope].filter((x) => x.file !== a.file);
          return undefined;
        case "settings_set_project_dir":
          return a.path;
        default:
          return undefined;
      }
    });
    useAgentsStore.setState({ projectDir: "/p", recentDirs: [], loaded: true });
    useTasksStore.setState({ scope: "project", newTaskRequest: 0 });
  });

  it("groups the project's tasks by status, counts and filters them", async () => {
    render(<TasksView />);
    const todo = await screen.findByRole("list", { name: "Zadania: Do zrobienia" });
    expect(within(todo).getByText("Eksport CSV")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Zadania: W toku" })).getByText("Logowanie")).toBeInTheDocument();
    // "Gotowe" starts collapsed, with its count.
    const done = screen.getByRole("region", { name: "Gotowe" });
    expect(within(done).getByRole("button", { name: /Gotowe/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(done).getByText("1")).toBeInTheDocument();
    fireEvent.click(within(done).getByRole("button", { name: /Gotowe/ }));
    expect(await within(done).findByText("Stare")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filtruj zadania"), { target: { value: "logow" } });
    expect(screen.queryByText("Eksport CSV")).toBeNull();
    expect(screen.getByText("Logowanie")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filtruj zadania"), { target: { value: "#1" } });
    expect(screen.getByText("Eksport CSV")).toBeInTheDocument();
    expect(screen.queryByText("Logowanie")).toBeNull();

    fireEvent.click(screen.getByText("Eksport CSV"));
    expect(openFile).toHaveBeenCalledWith("/p/.leverframe/tasks/1-eksport-csv.md");
  });

  it("creates a task and opens it", async () => {
    render(<TasksView />);
    await screen.findByText("Eksport CSV");
    fireEvent.click(screen.getByLabelText("Nowe zadanie…"));
    fireEvent.change(screen.getByLabelText("Tytuł nowego zadania"), { target: { value: "  Nowy raport  " } });
    fireEvent.click(screen.getByText("Utwórz"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_create", { scope: "project", title: "Nowy raport" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("/p/.leverframe/tasks/4-nowy-raport.md"));
    expect(await screen.findByText("Nowy raport")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tytuł nowego zadania")).toBeNull();
  });

  it("changes the status, moves and deletes from the menu", async () => {
    render(<TasksView />);
    await screen.findByText("Eksport CSV");
    fireEvent.click(screen.getByLabelText("Więcej: Eksport CSV"));
    const menu = screen.getByRole("menu", { name: "Zadanie #1" });
    expect(within(menu).queryByText("Do zrobienia")).toBeNull();
    fireEvent.click(within(menu).getByText("Do sprawdzenia"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("tasks_update", { scope: "project", file: "1-eksport-csv.md", change: { status: "review" } }),
    );
    expect(await within(screen.getByRole("list", { name: "Zadania: Do sprawdzenia" })).findByText("Eksport CSV")).toBeInTheDocument();

    // The context menu is the same menu.
    fireEvent.contextMenu(screen.getByText("Logowanie"));
    fireEvent.click(within(screen.getByRole("menu", { name: "Zadanie #2" })).getByText("Przenieś do globalnych"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_move", { scope: "project", file: "2-logowanie.md", to: "global" }));
    expect(closeEditorsUnder).toHaveBeenCalledWith("/p/.leverframe/tasks/2-logowanie.md");
    await waitFor(() => expect(screen.queryByText("Logowanie")).toBeNull());

    fireEvent.click(screen.getByLabelText("Więcej: Eksport CSV"));
    fireEvent.click(screen.getByText("Usuń…"));
    const confirm = screen.getByRole("group", { name: "Usuwanie zadania #1" });
    fireEvent.click(within(confirm).getByText("Do kosza"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_delete", { scope: "project", file: "1-eksport-csv.md", permanently: false }));
    expect(closeEditorsUnder).toHaveBeenCalledWith("/p/.leverframe/tasks/1-eksport-csv.md");
    await waitFor(() => expect(screen.queryByText("Eksport CSV")).toBeNull());
  });

  it("switches to the global list and remembers it", async () => {
    render(<TasksView />);
    await screen.findByText("Eksport CSV");
    fireEvent.click(screen.getByRole("button", { name: "Globalne" }));
    expect(await screen.findByText("Wspólne narzędzia")).toBeInTheDocument();
    expect(screen.queryByText("Eksport CSV")).toBeNull();
    expect(useTasksStore.getState().scope).toBe("global");
    // Clicking the list shown keeps it.
    fireEvent.click(screen.getByRole("button", { name: "Globalne" }));
    expect(screen.getByText("Wspólne narzędzia")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Więcej: Wspólne narzędzia"));
    expect(screen.getByText("Przenieś do projektu")).toBeInTheDocument();
  });

  it("asks for a project folder in the project list only", async () => {
    useAgentsStore.setState({ projectDir: null });
    openDialog.mockResolvedValue("/p");
    render(<TasksView />);
    expect(screen.getByText(/Nie wybrano folderu projektu/)).toBeInTheDocument();
    expect(screen.getByLabelText("Nowe zadanie…")).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith("tasks_list", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Globalne" }));
    expect(await screen.findByText("Wspólne narzędzia")).toBeInTheDocument();
  });

  it("refreshes when a file is saved and opens the form on request", async () => {
    render(<TasksView />);
    await screen.findByText("Eksport CSV");
    db.project[0].title = "Eksport CSV i XLSX";
    act(() => notifyFilesChanged(["/p/.leverframe/tasks/1-eksport-csv.md"]));
    expect(await screen.findByText("Eksport CSV i XLSX")).toBeInTheDocument();
    act(() => useTasksStore.getState().requestNewTask());
    expect(await screen.findByLabelText("Tytuł nowego zadania")).toBeInTheDocument();
  });

  it("shows the list chosen last when an older listing answers late", async () => {
    let answer: (tasks: Task[]) => void = () => undefined;
    render(<TasksView />);
    await screen.findByText("Eksport CSV");
    const plain = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) =>
      cmd === "tasks_list" && a.scope === "project" ? new Promise((r) => (answer = r)) : plain(cmd, a),
    );
    fireEvent.click(screen.getByLabelText("Odśwież"));
    fireEvent.click(screen.getByRole("button", { name: "Globalne" }));
    expect(await screen.findByText("Wspólne narzędzia")).toBeInTheDocument();
    await act(async () => answer(db.project));
    expect(screen.getByText("Wspólne narzędzia")).toBeInTheDocument();
    expect(screen.queryByText("Eksport CSV")).toBeNull();
  });

  it("shows errors of the backend", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "tasks_list") throw "Nie można odczytać /p/.leverframe/tasks: brak dostępu";
    });
    render(<TasksView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("brak dostępu");
  });
});
