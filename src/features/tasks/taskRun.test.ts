import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: async () => true }));
vi.mock("../terminal/keys", async (original) => ({ ...(await original<typeof import("../terminal/keys")>()), isWindows: () => false }));
const openAgent = vi.fn<(...a: unknown[]) => string>(() => "terminal-1");
const openAgentChat = vi.fn<(...a: unknown[]) => string>(() => "chat-1");
vi.mock("../../workbench/commands", () => ({
  openAgent: (...a: unknown[]) => openAgent(...a),
  openAgentChat: (...a: unknown[]) => openAgentChat(...a),
}));

import { checkLiveRuns, fileUri, liveKey, relativeTo, startTaskRun, taskPrompt, wslPath } from "./taskRun";
import type { Task } from "./tasksClient";
import { useAgentsStore } from "../../store/agents";
import { useChatsStore, type ChatEntry } from "../../store/chats";
import { useProfilesStore } from "../../store/profiles";
import { useSettingsStore } from "../../store/settings";
import { useTasksStore } from "../../store/tasks";
import { useTerminalStore } from "../../store/terminal";
import { initialChat } from "../acp/chatState";

const task: Task = {
  id: 1,
  title: "Eksport CSV",
  status: "todo",
  created: "2026-11-25",
  file: "1-eksport-csv.md",
  path: "/home/me/sklep/.leverframe/tasks/1-eksport-csv.md",
  scope: "project",
  runs: [],
};

describe("paths and the message for an agent", () => {
  it("fills the template", () => {
    expect(taskPrompt(null, ".leverframe/tasks/1-a.md", "A")).toMatch(/^Wykonaj zadanie opisane w pliku \.leverframe\/tasks\/1-a\.md \(A\)\./);
    expect(taskPrompt("Zrób {tytul}: {plik}", "p.md", "T")).toBe("Zrób T: p.md");
    expect(taskPrompt("Zrób to", "p.md", "T")).toBe("Zrób to (p.md)");
  });
  it("translates paths for WSL and relative to the working folder", () => {
    expect(wslPath("C:\\Users\\Jan\\sklep\\a.md")).toBe("/mnt/c/Users/Jan/sklep/a.md");
    expect(wslPath("\\\\wsl.localhost\\Ubuntu\\home\\jan\\a.md")).toBe("/home/jan/a.md");
    expect(wslPath("/home/jan/a.md")).toBe("/home/jan/a.md");
    expect(relativeTo("/home/me/sklep/.leverframe/tasks/1.md", "/home/me/sklep/")).toBe(".leverframe/tasks/1.md");
    expect(relativeTo("/data/tasks/1.md", "/home/me/sklep")).toBe("/data/tasks/1.md");
    expect(relativeTo("C:\\P\\Sklep\\a.md", "c:\\p\\sklep", true)).toBe("a.md");
    expect(fileUri("/home/me/zadanie 1.md")).toBe("file:///home/me/zadanie%201.md");
    expect(fileUri("C:\\x\\a.md")).toBe("file:///C:/x/a.md");
  });
});

describe("startTaskRun (#107, #108)", () => {
  beforeEach(() => {
    invoke.mockReset();
    openAgent.mockClear();
    openAgentChat.mockClear();
    invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
      if (cmd === "tasks_add_run") return { ...task, status: "doing", runs: [a.run] };
      if (cmd === "tasks_copy_to") return `/srv/app/.leverframe/tasks/${a.file}`;
      if (cmd === "docker_prepare_container") return { running: true, started: false, workdir: "/workspace", mounts: [{ kind: "bind", source: "/home/me/sklep", destination: "/workspace", name: null, readWrite: true }] };
      if (cmd === "tasks_list") return [];
      return undefined;
    });
    useProfilesStore.setState({
      profiles: [
        { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" },
        { id: "ssh:srv", name: "srv", kind: "ssh", command: "ssh", args: [], source: "detected" },
        { id: "docker:api", name: "api", kind: "container", command: "docker", args: [], source: "detected", container: { name: "api", autoStart: true } },
      ],
      defaultProfileId: "local:bash",
    } as Partial<ReturnType<typeof useProfilesStore.getState>>);
    useAgentsStore.setState({ remoteDirs: { "ssh:srv": "/srv/app" } });
    useSettingsStore.setState({ values: {} } as Partial<ReturnType<typeof useSettingsStore.getState>>);
    useTasksStore.setState({ live: {} });
  });

  it("starts a conversation that sends the task file, notes the run and watches it", async () => {
    const { run } = await startTaskRun({ task, agentId: "claude", profileId: null, mode: "chat", cwd: "/home/me/sklep" });
    expect(invoke).toHaveBeenCalledWith("tasks_add_run", {
      scope: "project",
      file: "1-eksport-csv.md",
      run: expect.objectContaining({ agent: "claude", profile: "local:bash", mode: "chat", cwd: "/home/me/sklep", remote: null }),
    });
    expect(openAgentChat).toHaveBeenCalledWith("claude", {
      profileId: "local:bash",
      cwd: "/home/me/sklep",
      initialPrompt: {
        text: expect.stringContaining("w pliku .leverframe/tasks/1-eksport-csv.md (Eksport CSV)"),
        resource: { uri: "file:///home/me/sklep/.leverframe/tasks/1-eksport-csv.md", name: "1-eksport-csv.md" },
      },
    });
    expect(useTasksStore.getState().live[liveKey(task.path, run.at)]).toMatchObject({ mode: "chat", target: "chat-1" });
  });

  it("starts the agent in a terminal with the message; a container sees the mounted file", async () => {
    useSettingsStore.setState({ values: { tasksPrompt: "Zadanie: {plik}" } } as Partial<ReturnType<typeof useSettingsStore.getState>>);
    await startTaskRun({ task, agentId: "opencode", profileId: "docker:api", mode: "terminal", cwd: "/home/me/sklep" });
    expect(invoke).not.toHaveBeenCalledWith("tasks_copy_to", expect.anything());
    expect(openAgent).toHaveBeenCalledWith("opencode", { profileId: "docker:api", cwd: "/home/me/sklep", prompt: "Zadanie: .leverframe/tasks/1-eksport-csv.md" });
  });

  it("copies the task to an SSH host and to a container without the folder", async () => {
    await startTaskRun({ task, agentId: "claude", profileId: "ssh:srv", mode: "chat", cwd: "/home/me/sklep" });
    expect(invoke).toHaveBeenCalledWith("tasks_copy_to", { scope: "project", file: "1-eksport-csv.md", profileId: "ssh:srv", dir: "/srv/app" });
    const chat = openAgentChat.mock.calls[0][1] as { cwd: string | null; initialPrompt: { resource: { uri: string } } };
    expect(chat.cwd).toBeNull();
    expect(chat.initialPrompt.resource.uri).toBe("file:///srv/app/.leverframe/tasks/1-eksport-csv.md");
    expect(invoke).toHaveBeenCalledWith("tasks_add_run", expect.objectContaining({ run: expect.objectContaining({ remote: "/srv/app/.leverframe/tasks/1-eksport-csv.md" }) }));

    const global = { ...task, scope: "global" as const, path: "/data/tasks/1-eksport-csv.md" };
    await startTaskRun({ task: global, agentId: "claude", profileId: "docker:api", mode: "chat", cwd: "/home/me/sklep" });
    expect(invoke).toHaveBeenCalledWith("tasks_copy_to", { scope: "global", file: "1-eksport-csv.md", profileId: "docker:api", dir: "/workspace" });
  });
});

describe("watching runs (#109)", () => {
  const chat = (status: ChatEntry["state"]["status"]): ChatEntry =>
    ({ id: "chat-1", params: { agentId: "claude" }, state: { ...initialChat, status }, live: true, historyLoading: false, historyError: null, createdAt: 0, scrollSeq: 0 }) as ChatEntry;
  const live = (mode: "chat" | "terminal", target: string) => ({ key: `k-${mode}`, scope: "project" as const, file: task.file, path: task.path, mode, target, sawBusy: false, seen: false });

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => (cmd === "tasks_list" ? [{ ...task, status: "doing" }] : undefined));
    useChatsStore.setState({ chats: {}, order: [] });
    useTerminalStore.setState({ running: [] });
  });

  it("sets the task „Do sprawdzenia” when the agent's turn on it ends", async () => {
    useTasksStore.setState({ live: { "k-chat": live("chat", "chat-1") } });
    useChatsStore.setState({ chats: { "chat-1": chat("ready") } });
    checkLiveRuns();
    expect(useTasksStore.getState().live["k-chat"]).toBeDefined();
    useChatsStore.setState({ chats: { "chat-1": chat("busy") } });
    checkLiveRuns();
    useChatsStore.setState({ chats: { "chat-1": chat("ready") } });
    checkLiveRuns();
    expect(useTasksStore.getState().live["k-chat"]).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_update", { scope: "project", file: task.file, change: { status: "review" } }));
  });

  it("waits for the terminal's tab, then ends the run when it closes", async () => {
    useTasksStore.setState({ live: { "k-terminal": live("terminal", "terminal-1") } });
    checkLiveRuns();
    expect(useTasksStore.getState().live["k-terminal"]).toBeDefined();
    useTerminalStore.setState({ running: [{ panelId: "terminal-1", dock: "panel", title: "t", profileId: null, exited: false }] });
    checkLiveRuns();
    expect(useTasksStore.getState().live["k-terminal"].seen).toBe(true);
    useTerminalStore.setState({ running: [] });
    checkLiveRuns();
    expect(useTasksStore.getState().live["k-terminal"]).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_update", expect.objectContaining({ change: { status: "review" } })));
  });

  it("leaves a status the user changed meanwhile", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "tasks_list" ? [{ ...task, status: "done" }] : undefined));
    useTasksStore.setState({ live: { "k-chat": live("chat", "chat-1") } });
    checkLiveRuns();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_list", { scope: "project" }));
    expect(invoke).not.toHaveBeenCalledWith("tasks_update", expect.anything());
  });
});
