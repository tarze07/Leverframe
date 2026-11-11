import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
const writeText = vi.fn(async (text: string) => void text);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => writeText(t) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
const openAgent = vi.fn();
const openAgentChat = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openAgent: (...a: unknown[]) => openAgent(...a),
  openAgentChat: (...a: unknown[]) => openAgentChat(...a),
}));

import { AgentsView } from "./AgentsView";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";

const agents = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Agent",
    commands: ["claude"],
    docsUrl: "https://x",
    install: [{ platform: "unix", command: "curl -fsSL https://claude.ai/install.sh | bash" }],
    acp: { command: "claude-agent-acp", args: [], install: [{ platform: "any", command: "npm install -g @agentclientprotocol/claude-agent-acp" }] },
  },
  { id: "kilo", name: "Kilo Code", commands: ["kilo", "kilocode"], install: [{ platform: "any", command: "npm install -g @kilocode/cli" }] },
];
const profiles = [
  { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" },
  { id: "user-1", name: "prod", kind: "ssh", command: "ssh", args: [], source: "user", ssh: { host: "prod" } },
];

function mockBackend(detectResult: (profileId: string) => unknown) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "agents_list":
        return { agents, errors: [], configPath: "/cfg/agents.json" };
      case "settings_project_dir":
        return "/home/me/projects/app";
      case "settings_set_project_dir":
        return args?.path ?? null;
      case "settings_recent_project_dirs":
        return ["/home/me/projects/app", "/home/me/projects/api", "/srv/docs"];
      case "settings_remote_dirs":
        return { "user-1": "~/srv-app" };
      case "settings_set_remote_dir":
        return (args?.path as string | null) ?? null;
      case "profiles_list":
        return { profiles, defaultProfileId: "local:bash" };
      case "agents_detect":
        return detectResult(args?.profileId as string);
      default:
        return undefined;
    }
  });
}

describe("AgentsView", () => {
  beforeEach(() => {
    invoke.mockReset();
    openAgent.mockReset();
    openAgentChat.mockReset();
    useAgentsStore.setState({
      agents: [],
      errors: [],
      loaded: false,
      profileId: null,
      projectDir: null,
      recentDirs: [],
      remoteDirs: {},
      detection: {},
    });
    useProfilesStore.setState({ profiles: [], defaultProfileId: null, status: "idle", error: null });
  });

  it("detects agents in the default profile and shows versions", async () => {
    mockBackend(() => [
      { id: "claude", installed: true, command: "claude", version: "2.1.0 (Claude Code)" },
      { id: "kilo", installed: false, command: null, version: null },
    ]);
    render(<AgentsView />);
    expect(await screen.findByText("2.1.0 (Claude Code)")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("agents_detect", { profileId: "local:bash", force: false });
    expect(within(screen.getByRole("listitem", { name: "Kilo Code" })).getByText("nie znaleziono")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument(); // project folder name
  });

  it("launches an agent in the selected profile with the project folder", async () => {
    mockBackend(() => [{ id: "claude", installed: true, command: "claude", version: "2.1.0" }]);
    render(<AgentsView />);
    await screen.findByText("2.1.0");
    const card = screen.getByRole("listitem", { name: "Claude Code" });
    fireEvent.click(within(card).getByText("Terminal"));
    expect(openAgent).toHaveBeenCalledWith("claude", { profileId: "local:bash", cwd: "/home/me/projects/app", split: undefined });
    fireEvent.click(within(card).getByLabelText("Uruchom Claude Code w podziale"));
    expect(openAgent).toHaveBeenLastCalledWith("claude", expect.objectContaining({ split: "right" }));
  });

  it("re-detects for another profile and does not pass a local folder to SSH", async () => {
    mockBackend((p) => [{ id: "claude", installed: p === "user-1", command: "claude", version: p === "user-1" ? "remote 1.0" : null }]);
    render(<AgentsView />);
    await screen.findAllByText("nie znaleziono");
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "user-1" } });
    expect(await screen.findByText("remote 1.0")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("agents_detect", { profileId: "user-1", force: false });
    fireEvent.click(within(screen.getByRole("listitem", { name: "Claude Code" })).getByText("Terminal"));
    expect(openAgent).toHaveBeenCalledWith("claude", expect.objectContaining({ profileId: "user-1", cwd: null }));
  });

  it("keeps a directory on the server for each SSH profile", async () => {
    mockBackend(() => []);
    render(<AgentsView />);
    await screen.findByText("app");
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "user-1" } });
    const input = await screen.findByLabelText("Katalog na serwerze prod");
    expect(input).toHaveValue("~/srv-app");
    expect(screen.queryByText("app")).not.toBeInTheDocument(); // the local folder does not apply
    fireEvent.change(input, { target: { value: " ~/projekty/shop " } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings_set_remote_dir", { profileId: "user-1", path: "~/projekty/shop" }),
    );
    await waitFor(() => expect(useAgentsStore.getState().remoteDirs["user-1"]).toBe("~/projekty/shop"));
    const cleared = screen.getByLabelText("Katalog na serwerze prod");
    fireEvent.change(cleared, { target: { value: "" } });
    fireEvent.keyDown(cleared, { key: "Enter" });
    fireEvent.blur(cleared);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_remote_dir", { profileId: "user-1", path: null }));
  });

  it("switches to a recently used folder", async () => {
    mockBackend(() => []);
    render(<AgentsView />);
    await screen.findByText("app");
    fireEvent.click(await screen.findByLabelText("Ostatnio używane foldery"));
    const list = screen.getByRole("list", { name: "Ostatnie foldery" });
    expect(within(list).queryByText("app")).not.toBeInTheDocument(); // the current one is not repeated
    fireEvent.click(within(list).getByText("api"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_project_dir", { path: "/home/me/projects/api" }));
    expect(await screen.findByText("api")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Ostatnie foldery" })).not.toBeInTheDocument();
  });

  it("offers a conversation (ACP) for agents that have it", async () => {
    mockBackend((p) => [
      { id: "claude", installed: true, command: "claude", version: "2.1.0", acp: p === "local:bash" },
      { id: "kilo", installed: true, command: "kilo", version: "7.8", acp: null },
    ]);
    render(<AgentsView />);
    const claude = await screen.findByRole("listitem", { name: "Claude Code" });
    expect(await within(claude).findByText("tryb rozmowy dostępny")).toBeInTheDocument();
    const kilo = screen.getByRole("listitem", { name: "Kilo Code" });
    expect(within(kilo).queryByText("Rozmowa")).not.toBeInTheDocument(); // terminal only
    fireEvent.click(within(claude).getByText("Rozmowa"));
    expect(openAgentChat).toHaveBeenCalledWith("claude", { profileId: "local:bash", cwd: "/home/me/projects/app" });
    expect(openAgent).not.toHaveBeenCalled();

    // On SSH the local folder is not passed (the backend uses the directory on the server).
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "user-1" } });
    const remote = await screen.findByRole("listitem", { name: "Claude Code" });
    expect(await within(remote).findByText("tryb rozmowy: brak programu claude-agent-acp")).toBeInTheDocument();
    fireEvent.click(within(remote).getByText("Rozmowa"));
    expect(openAgentChat).toHaveBeenLastCalledWith("claude", { profileId: "user-1", cwd: null });
  });

  it("shows how to install a missing ACP adapter", async () => {
    mockBackend(() => [{ id: "claude", installed: true, command: "claude", version: "2.1.0", acp: false }]);
    render(<AgentsView />);
    const card = await screen.findByRole("listitem", { name: "Claude Code" });
    fireEvent.click(await within(card).findByText("Jak zainstalować?"));
    expect(within(card).getByText("npm install -g @agentclientprotocol/claude-agent-acp")).toBeInTheDocument();
    expect(within(card).queryByText(/install\.sh/)).not.toBeInTheDocument(); // the CLI itself is installed
    expect(within(card).getByText(/potrzebny jest Node\.js/)).toBeInTheDocument();
  });

  it("shows install commands for missing agents and copies them", async () => {
    mockBackend(() => [{ id: "kilo", installed: false, command: null, version: null }]);
    render(<AgentsView />);
    const card = await screen.findByRole("listitem", { name: "Kilo Code" });
    fireEvent.click(await within(card).findByText("Jak zainstalować?"));
    expect(within(card).getByText("npm install -g @kilocode/cli")).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText("Kopiuj komendę instalacji"));
    expect(writeText).toHaveBeenCalledWith("npm install -g @kilocode/cli");
  });

  it("shows detection errors and lets you retry", async () => {
    let fail = true;
    mockBackend(() => {
      if (fail) throw "Brak odpowiedzi z hosta SSH";
      return [{ id: "claude", installed: true, command: "claude", version: "ok 1" }];
    });
    render(<AgentsView />);
    expect(await screen.findByText("Brak odpowiedzi z hosta SSH")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByLabelText("Sprawdź ponownie"));
    expect(await screen.findByText("ok 1")).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("agents_detect", { profileId: "local:bash", force: true });
  });

  it("does not search again after a failed detection until asked", async () => {
    mockBackend((p) => {
      if (p === "user-1") throw "Brak odpowiedzi z hosta SSH";
      return [{ id: "claude", installed: true, command: "claude", version: "local 1" }];
    });
    const detectCalls = (profileId: string) =>
      invoke.mock.calls.filter(([cmd, args]) => cmd === "agents_detect" && (args as { profileId: string }).profileId === profileId);

    const view = render(<AgentsView />);
    await screen.findByText("local 1");
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "user-1" } });
    expect(await screen.findByText("Brak odpowiedzi z hosta SSH")).toBeInTheDocument();
    expect(screen.getByText(/nie będzie ponawiane samo/)).toBeInTheDocument();

    // Back to the local profile and to the SSH one again, then the panel is closed and reopened.
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "local:bash" } });
    await screen.findByText("local 1");
    fireEvent.change(screen.getByLabelText("Uruchamiaj w terminalu"), { target: { value: "user-1" } });
    view.unmount();
    render(<AgentsView />);
    expect(await screen.findByText("Brak odpowiedzi z hosta SSH")).toBeInTheDocument();
    expect(detectCalls("user-1")).toHaveLength(1);
    expect(detectCalls("local:bash")).toHaveLength(1);

    // Agents can still be launched without detection.
    fireEvent.click(within(screen.getByRole("listitem", { name: "Claude Code" })).getByText("Terminal"));
    expect(openAgent).toHaveBeenCalledWith("claude", expect.objectContaining({ profileId: "user-1" }));

    fireEvent.click(screen.getByLabelText("Sprawdź ponownie"));
    await waitFor(() => expect(detectCalls("user-1")).toHaveLength(2));
    expect(invoke).toHaveBeenLastCalledWith("agents_detect", { profileId: "user-1", force: true });
  });

  it("picks and clears the project folder", async () => {
    mockBackend(() => []);
    openDialog.mockResolvedValue("/home/me/other");
    render(<AgentsView />);
    fireEvent.click(await screen.findByText("app"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_project_dir", { path: "/home/me/other" }));
    expect(await screen.findByText("other")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Wyczyść folder projektu"));
    expect(await screen.findByText("Folder domowy (wybierz…)")).toBeInTheDocument();
  });
});
