import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/home/me/inny" }));
const startTaskRun = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("./taskRun", () => ({ startTaskRun: (...a: unknown[]) => startTaskRun(...a), liveKey: (p: string, at: string) => `${p}|${at}` }));
const cmd = vi.hoisted(() => ({ openAgentChatHistory: vi.fn(), openChatPanel: vi.fn(), openDiff: vi.fn(), openSessionPlayer: vi.fn(), revealTerminal: vi.fn() }));
vi.mock("../../workbench/commands", () => cmd);

import { RunTaskForm, TaskRunsList, recordForRun } from "./TaskRuns";
import type { Task, TaskRun } from "./tasksClient";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { useTasksStore } from "../../store/tasks";
import type { SessionRecord } from "../sessions/sessionsClient";

const agents = [
  { id: "claude", name: "Claude Code", commands: ["claude"], install: [], acp: { command: "claude-agent-acp", args: [], install: [] }, args: [], env: {}, hidden: false, builtin: true, promptArg: "" },
  { id: "agy", name: "Agy", commands: ["agy"], install: [], acp: null, args: [], env: {}, hidden: false, builtin: true, promptArg: null },
  { id: "gemini", name: "Gemini CLI", commands: ["gemini"], install: [], acp: { command: "gemini", args: ["--acp"], install: [] }, args: [], env: {}, hidden: false, builtin: true, promptArg: "-i" },
];
const task = (over: Partial<Task> = {}): Task => ({
  id: 3,
  title: "Raport",
  status: "todo",
  created: "",
  file: "3-raport.md",
  path: "/home/me/sklep/.leverframe/tasks/3-raport.md",
  scope: "project",
  runs: [],
  ...over,
});

describe("RunTaskForm (#107)", () => {
  beforeEach(() => {
    startTaskRun.mockClear();
    useAgentsStore.setState({ agents, projectDir: "/home/me/sklep", recentDirs: ["/home/me/stary"], remoteDirs: { "ssh:srv": "/srv/app" }, profileId: null } as never);
    useProfilesStore.setState({
      profiles: [
        { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" },
        { id: "ssh:srv", name: "srv", kind: "ssh", command: "ssh", args: [], source: "detected" },
      ],
      defaultProfileId: "local:bash",
    } as never);
  });

  it("starts the chosen agent in conversation mode in the project folder", async () => {
    const onStarted = vi.fn();
    render(<RunTaskForm task={task()} onStarted={onStarted} onCancel={() => undefined} />);
    expect(screen.getByLabelText("Agent")).toHaveValue("claude");
    expect(screen.getByLabelText("Profil")).toHaveValue("local:bash");
    expect(screen.getByRole("radio", { name: "Rozmowa" })).toBeChecked();
    fireEvent.click(screen.getByText("Uruchom"));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(startTaskRun).toHaveBeenCalledWith({ task: task(), agentId: "claude", profileId: "local:bash", mode: "chat", cwd: "/home/me/sklep" });
  });

  it("offers only the modes the agent has; shows the server folder for SSH", async () => {
    render(<RunTaskForm task={task()} onStarted={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "agy" } });
    expect(screen.getByRole("radio", { name: "Rozmowa" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Terminal" })).toBeDisabled();
    expect(screen.getByText("Uruchom")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "gemini" } });
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    fireEvent.change(screen.getByLabelText("Profil"), { target: { value: "ssh:srv" } });
    expect(screen.getByText("/srv/app")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Uruchom"));
    await waitFor(() => expect(startTaskRun).toHaveBeenCalledWith(expect.objectContaining({ agentId: "gemini", profileId: "ssh:srv", mode: "terminal" })));
  });

  it("asks a global task for its working folder", async () => {
    render(<RunTaskForm task={task({ scope: "global", path: "/data/tasks/3-raport.md" })} onStarted={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByLabelText("Folder pracy")).toHaveValue("/home/me/sklep");
    fireEvent.click(screen.getByText("Wybierz…"));
    await waitFor(() => expect(screen.getByLabelText("Folder pracy")).toHaveValue("/home/me/inny"));
    fireEvent.click(screen.getByText("Uruchom"));
    await waitFor(() => expect(startTaskRun).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/home/me/inny" })));
  });

  it("shows why the start failed", async () => {
    startTaskRun.mockRejectedValueOnce("Profil „x” nie istnieje");
    render(<RunTaskForm task={task()} onStarted={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByText("Uruchom"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Profil „x” nie istnieje");
  });
});

describe("TaskRunsList (#108, #109)", () => {
  const chatRun: TaskRun = { at: "2026-11-25T14:00:00.000Z", agent: "claude", profile: "local:bash", mode: "chat", cwd: "/home/me/sklep" };
  const remoteRun: TaskRun = { at: "2026-11-25T15:00:00.000Z", agent: "gemini", profile: "ssh:srv", mode: "terminal", remote: "/srv/app/.leverframe/tasks/3-raport.md" };
  const record = (over: Partial<SessionRecord>): SessionRecord =>
    ({ id: 7, kind: "acp", agentId: "claude", startedAt: Date.parse(chatRun.at) + 900, ...over }) as SessionRecord;

  beforeEach(() => {
    Object.values(cmd).forEach((f) => f.mockClear());
    invoke.mockReset();
    useTasksStore.setState({ live: {} });
  });

  it("finds the recording of a run", () => {
    const at = Date.parse(chatRun.at);
    expect(recordForRun([record({ id: 1, startedAt: at - 60_000 }), record({ id: 2, startedAt: at + 2_000 }), record({ id: 3, startedAt: at + 1_000 }), record({ id: 4, agentId: "x", startedAt: at })], chatRun)?.id).toBe(3);
    expect(recordForRun([record({ startedAt: at + 3_600_000 })], chatRun)).toBeUndefined();
  });

  it("opens a live run's tab, an ended one from the history", async () => {
    useTasksStore.setState({ live: { [`${task().path}|${chatRun.at}`]: { key: "k", scope: "project", file: "3-raport.md", path: task().path, mode: "chat", target: "chat-9", sawBusy: true, seen: false } } });
    invoke.mockImplementation(async (c: string) => (c === "sessions_list" ? [record({})] : undefined));
    const { rerender } = render(<TaskRunsList task={task({ runs: [chatRun] })} />);
    expect(screen.getByText("trwa")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Claude Code · bash · rozmowa/));
    expect(cmd.openChatPanel).toHaveBeenCalledWith("chat-9");

    useTasksStore.setState({ live: {} });
    rerender(<TaskRunsList task={task({ runs: [chatRun] })} />);
    fireEvent.click(screen.getByText(/Claude Code · bash · rozmowa/));
    await waitFor(() => expect(cmd.openAgentChatHistory).toHaveBeenCalledWith(expect.objectContaining({ id: 7 })));
    expect(invoke).toHaveBeenCalledWith("sessions_list", { filter: expect.objectContaining({ kind: "acp", agentId: "claude" }) });
  });

  it("fetches the result from the agent's computer and saves it after showing the changes", async () => {
    let written: unknown = null;
    invoke.mockImplementation(async (c: string, a: Record<string, unknown>) => {
      if (c === "tasks_read_remote") return "# Raport\n\n## Wynik\nGotowe.\n";
      if (c === "fs_read_text") return { path: a.path, content: "# Raport\n", mtime: 5, size: 9 };
      if (c === "fs_write_text") return ((written = a), 6);
      return undefined;
    });
    render(<TaskRunsList task={task({ runs: [remoteRun] })} />);
    fireEvent.click(screen.getByText("Pobierz wynik"));
    await waitFor(() => expect(cmd.openDiff).toHaveBeenCalledWith({ path: task().path, oldText: "# Raport\n", newText: "# Raport\n\n## Wynik\nGotowe.\n" }));
    expect(invoke).toHaveBeenCalledWith("tasks_read_remote", { profileId: "ssh:srv", path: remoteRun.remote });
    fireEvent.click(await screen.findByText("Zapisz w zadaniu"));
    expect(await screen.findByText("Zapisano wynik w pliku zadania.")).toBeInTheDocument();
    expect(written).toEqual({ path: task().path, content: "# Raport\n\n## Wynik\nGotowe.\n", expectedMtime: 5 });
  });

  it("says when the copy has not changed", async () => {
    invoke.mockImplementation(async (c: string) => (c === "tasks_read_remote" ? "# Raport\n" : { path: "", content: "# Raport\n", mtime: 1, size: 9 }));
    render(<TaskRunsList task={task({ runs: [remoteRun] })} />);
    fireEvent.click(screen.getByText("Pobierz wynik"));
    expect(await screen.findByText(/nie różni się od zadania/)).toBeInTheDocument();
    expect(cmd.openDiff).not.toHaveBeenCalled();
  });
});
