import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { AcpEvent, AcpHandle, SessionUpdate } from "./acpClient";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { useEditorStore } from "../../store/editor";

vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openAgent = vi.fn();
const openFile = vi.fn();
vi.mock("../../workbench/commands", async (original) => ({
  ...(await original<typeof import("../../workbench/commands")>()),
  openAgent: (...a: unknown[]) => openAgent(...a),
  openFile: (...a: unknown[]) => openFile(...a),
  openAgentTerminal: (...a: unknown[]) => openAgentTerminal(...a),
}));
const openAgentTerminal = vi.fn();
// xterm does not run in jsdom: the live view is replaced by its key.
vi.mock("./AgentTerminalView", () => ({
  AgentTerminalView: ({ storeKey }: { storeKey: string }) => <div data-testid="terminal-view">{storeKey}</div>,
}));
const openUrl = vi.fn(async (u: string) => void u);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

let emit: (e: AcpEvent) => void = () => undefined;
const handle = {
  id: 7,
  prompt: vi.fn<(text: string) => Promise<string>>(async () => "end_turn"),
  cancel: vi.fn(async () => undefined),
  replyPermission: vi.fn(async () => undefined),
  replyFs: vi.fn(async () => undefined),
  replyTerminal: vi.fn(async () => undefined),
  authenticate: vi.fn(async () => undefined),
  setMode: vi.fn(async () => undefined),
  setConfigOption: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => ({
    sessions: [
      { sessionId: "s1", cwd: "/home/me/app", title: "Ta rozmowa" },
      { sessionId: "old-1", cwd: "/home/me/app", title: "Wczorajsza rozmowa", updatedAt: "2026-11-11T10:00:00Z" },
      { sessionId: "old-2", cwd: "/home/me/app", title: "Starsza rozmowa" },
    ],
    nextCursor: null,
  })),
  loadSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
} satisfies AcpHandle;
const readTranscript = vi.fn(async (id: number) => `${id}`);
vi.mock("../sessions/sessionsClient", () => ({ sessionsClient: { read: (id: number) => readTranscript(id) } }));
const startAcp = vi.fn(async (_req: unknown, onEvent: (e: AcpEvent) => void) => {
  emit = onEvent;
  return handle;
});
vi.mock("./acpClient", () => ({ startAcp: (req: unknown, onEvent: (e: AcpEvent) => void) => startAcp(req, onEvent) }));

import { AgentChatPanel, type AgentChatParams } from "./AgentChatPanel";
import { createChat, endAllChats, endChat, requestChatScroll, useChatsStore, type ChatParams } from "../../store/chats";

const panelApi = { id: "chat-7", title: "Claude Code · rozmowa", setTitle: vi.fn() };
/** A new conversation (as the Agenci view starts it) shown in a tab. */
const props = (params: ChatParams) => ({ params: { chatId: createChat(params) }, api: panelApi }) as unknown as IDockviewPanelProps<AgentChatParams>;
const update = (u: SessionUpdate) => act(() => emit({ type: "update", update: u }));
const ready = async () => {
  await waitFor(() => expect(startAcp).toHaveBeenCalled());
  act(() => {
    emit({ type: "initialized", agentInfo: { name: "fake", title: "Fake Agent", version: "1.0" }, agentCapabilities: {}, authMethods: [] });
    emit({
      type: "sessionReady",
      sessionId: "s1",
      cwd: "/home/me/app",
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Kod" }, { id: "ask", name: "Pytania" }] },
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Szybki" }, { value: "smart", name: "Dokładny" }] },
        { id: "web", name: "Dostęp do sieci", type: "boolean", currentValue: false },
      ],
    });
  });
};
const box = () => screen.getByLabelText("Wiadomość do agenta");
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
};

describe("AgentChatPanel", () => {
  beforeEach(() => {
    endAllChats();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    useAgentsStore.setState({
      agents: [
        {
          id: "claude",
          name: "Claude Code",
          commands: ["claude"],
          install: [],
          acp: { command: "claude-agent-acp", args: [], install: [{ platform: "any", command: "npm install -g @agentclientprotocol/claude-agent-acp" }] },
        },
      ],
    });
    useProfilesStore.setState({
      profiles: [
        { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" },
        { id: "srv", name: "serwer", kind: "ssh", command: "ssh", args: [], source: "user" },
      ],
      defaultProfileId: "local:bash",
    } as Partial<ReturnType<typeof useProfilesStore.getState>>);
  });

  it("streams the answer as Markdown, with plan and tool cards, and stops a turn", async () => {
    let finish: (reason: string) => void = () => undefined;
    handle.prompt.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    render(<AgentChatPanel {...props({ agentId: "claude", profileId: "local:bash", cwd: "/home/me/app" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    expect(startAcp.mock.calls[0][0]).toEqual({ agentId: "claude", profileId: "local:bash", cwd: "/home/me/app" });
    expect(screen.getByRole("status")).toHaveTextContent("Łączenie z agentem…");
    await ready();
    expect(screen.getByText("Fake Agent")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Gotowy");

    send("Popraw testy");
    expect(handle.prompt).toHaveBeenCalledWith("Popraw testy");
    expect(box()).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Agent pracuje…");
    update({ sessionUpdate: "plan", entries: [{ content: "Uruchomić testy", priority: "high", status: "in_progress" }] });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Czytam README.md",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "/home/me/app/README.md", line: 3 }],
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "# Sklep" } }] });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Gotowe: **1 test** nie przeszedł. " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[Dokumentacja](https://example.com)<script>alert(1)</script>" } });
    update({ sessionUpdate: "usage_update", used: 12300, size: 200000, cost: { amount: 0.42, currency: "USD" } });

    expect(screen.getByRole("group", { name: "Plan agenta" })).toHaveTextContent("Plan · 0/1");
    const card = screen.getByRole("group", { name: "Narzędzie: Czytam README.md" });
    expect(card).toHaveTextContent("gotowe");
    expect(card).toHaveTextContent("# Sklep");
    fireEvent.click(within(card).getByText("README.md:3"));
    expect(openFile).toHaveBeenCalledWith("/home/me/app/README.md", { line: 3 });

    const log = screen.getByRole("log");
    expect(log.querySelector("strong")).toHaveTextContent("1 test");
    expect(log.querySelector("script")).toBeNull(); // sanitized like the Markdown preview
    const link = within(log).getByText("Dokumentacja");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(screen.getByLabelText("Sesja agenta")).toHaveTextContent("kontekst 12 300 / 200 000 (6%) · 0,42 USD");

    fireEvent.click(screen.getByText("Stop"));
    expect(handle.cancel).toHaveBeenCalled();
    await act(async () => finish("cancelled"));
    expect(screen.getByText("Przerwano.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Gotowy");
  });

  it("suggests the agent's commands after /", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    update({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Przejrzyj zmiany", input: { hint: "co przejrzeć" } },
        { name: "init", description: "Utwórz AGENTS.md" },
      ],
    });
    fireEvent.change(box(), { target: { value: "/" } });
    const list = screen.getByRole("listbox", { name: "Komendy agenta" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["/reviewPrzejrzyj zmiany", "/initUtwórz AGENTS.md"]);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("/init");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box()).toHaveValue("/review ");
    expect(box()).toHaveAttribute("placeholder", "co przejrzeć"); // the command's input hint
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(box(), { target: { value: "/review ostatni commit" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(handle.prompt).toHaveBeenCalledWith("/review ostatni commit");

    fireEvent.change(box(), { target: { value: "/i" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("changes modes and options through the agent", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Tryb agenta"), { target: { value: "ask" } });
    expect(handle.setMode).toHaveBeenCalledWith("ask");
    expect(screen.getByLabelText("Tryb agenta")).toHaveValue("ask");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "smart" } });
    expect(handle.setConfigOption).toHaveBeenCalledWith("model", "smart");
    fireEvent.click(screen.getByLabelText("Dostęp do sieci"));
    expect(handle.setConfigOption).toHaveBeenCalledWith("web", true);
  });

  it("answers permission requests with the agent's options", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    act(() =>
      emit({
        type: "permission",
        requestId: 3,
        toolCall: { title: "Uruchom npm test" },
        options: [
          { optionId: "yes", name: "Zezwól raz", kind: "allow_once" },
          { optionId: "always", name: "Zawsze", kind: "allow_always" },
          { optionId: "no", name: "Odmów", kind: "reject_once" },
        ],
      }),
    );
    expect(screen.getByRole("group", { name: "Prośba o zgodę" })).toHaveTextContent("Uruchom npm test");
    expect(screen.getByText("Zawsze").closest("button")).toHaveAttribute("title", "Agent zapamięta tę decyzję · Klawisz 2");
    fireEvent.click(screen.getByText("Zezwól raz"));
    expect(handle.replyPermission).toHaveBeenCalledWith(3, "yes");
    act(() => emit({ type: "permissionClosed", requestId: 3 }));
    expect(screen.queryByRole("group", { name: "Prośba o zgodę" })).not.toBeInTheDocument();
  });

  it("shows the command and the change, takes number keys, and marks the tab while waiting", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    act(() =>
      emit({
        type: "permission",
        requestId: 4,
        toolCall: {
          toolCallId: "e1",
          title: "Edytuj README.md",
          kind: "edit",
          rawInput: { command: ["npm", "test"] },
          content: [{ type: "diff", path: "/home/me/app/README.md", oldText: "# Sklep\n", newText: "# Sklep\nNowa linia\n" }],
        },
        options: [
          { optionId: "yes", name: "Zezwól", kind: "allow_once" },
          { optionId: "no", name: "Odmów", kind: "reject_once" },
        ],
      }),
    );
    update({
      sessionUpdate: "tool_call",
      toolCallId: "e1",
      title: "Edytuj README.md",
      kind: "edit",
      content: [{ type: "diff", path: "/home/me/app/README.md", oldText: "# Sklep\n", newText: "# Sklep\nNowa linia\n" }],
    });
    const card = screen.getByRole("group", { name: "Prośba o zgodę" });
    expect(card).toHaveTextContent("npm test");
    // The change is shown once: in the permission request, not again in the tool card.
    expect(screen.getAllByLabelText("Zmiana: README.md")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Narzędzie: Edytuj README.md" })).toHaveTextContent("czeka na Twoją zgodę");
    const change = within(card).getByLabelText("Zmiana: README.md");
    expect(change).toHaveTextContent("+1");
    expect(change).toHaveTextContent("−0");
    expect(change).toHaveTextContent("+ Nowa linia");
    expect(panelApi.setTitle).toHaveBeenLastCalledWith("⚑ Claude Code · rozmowa");

    // Typing a message: digits are text, not choices.
    fireEvent.change(box(), { target: { value: "2" } });
    fireEvent.keyDown(box(), { key: "2" });
    expect(handle.replyPermission).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.keyDown(box(), { key: "2" });
    expect(handle.replyPermission).toHaveBeenCalledWith(4, "no");
    act(() => emit({ type: "permissionClosed", requestId: 4 }));
    expect(panelApi.setTitle).toHaveBeenLastCalledWith("Claude Code · rozmowa");
  });

  it("serves file requests in the project folder at once and asks for others", async () => {
    const editors = await import("../../store/editor");
    editors.useEditorStore.setState({
      editors: {
        e1: { path: "/home/me/app/a.ts", dirty: true, save: async () => true, getText: () => "niezapisane" },
      },
    });
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    await act(async () => emit({ type: "fsRequest", requestId: 5, op: "read", path: "/home/me/app/a.ts", inside: true, content: null }));
    await waitFor(() => expect(handle.replyFs).toHaveBeenCalledWith(5, { content: "niezapisane" }));
    expect(screen.queryByRole("group", { name: "Dostęp do pliku" })).not.toBeInTheDocument();

    act(() => emit({ type: "fsRequest", requestId: 6, op: "read", path: "/etc/hostname", inside: false, content: null }));
    const ask = screen.getByRole("group", { name: "Dostęp do pliku" });
    expect(ask).toHaveTextContent("Agent chce odczytać plik spoza folderu projektu:");
    expect(ask).toHaveTextContent("/etc/hostname");
    expect(handle.replyFs).toHaveBeenCalledTimes(1);
    fireEvent.click(within(ask).getByText("Odmów"));
    expect(handle.replyFs).toHaveBeenLastCalledWith(6, { error: expect.stringContaining("nie zezwolił") });
    act(() => emit({ type: "fsClosed", requestId: 6 }));
    expect(screen.queryByRole("group", { name: "Dostęp do pliku" })).not.toBeInTheDocument();
    editors.useEditorStore.setState({ editors: {} });
  });

  it("asks before the agent runs a command; 'always' covers the same command later", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    act(() => emit({ type: "terminalRequest", requestId: 9, command: "npm test", cwd: "/home/me/app" }));
    const card = screen.getByRole("group", { name: "Polecenie agenta" });
    expect(card).toHaveTextContent("Agent chce uruchomić polecenie w /home/me/app:");
    expect(card).toHaveTextContent("npm test");
    expect(panelApi.setTitle).toHaveBeenLastCalledWith("⚑ Claude Code · rozmowa");
    fireEvent.click(within(card).getByText("Zawsze dla tego polecenia"));
    expect(handle.replyTerminal).toHaveBeenCalledWith(9, true);
    act(() => emit({ type: "terminalRequestClosed", requestId: 9 }));
    expect(screen.queryByRole("group", { name: "Polecenie agenta" })).not.toBeInTheDocument();

    // The same command again: no question. Another one: a question, refused.
    act(() => emit({ type: "terminalRequest", requestId: 10, command: "npm test", cwd: null }));
    expect(handle.replyTerminal).toHaveBeenLastCalledWith(10, true);
    expect(screen.queryByRole("group", { name: "Polecenie agenta" })).not.toBeInTheDocument();
    act(() => emit({ type: "terminalRequest", requestId: 11, command: "rm -rf build", cwd: null }));
    fireEvent.click(within(screen.getByRole("group", { name: "Polecenie agenta" })).getByText("Odmów"));
    expect(handle.replyTerminal).toHaveBeenLastCalledWith(11, false);
  });

  it("runs commands without asking when that is turned off in the settings", async () => {
    const settings = await import("../../store/settings");
    settings.useSettingsStore.setState({ values: { acpConfirmCommands: false } });
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    act(() => emit({ type: "terminalRequest", requestId: 12, command: "cargo build", cwd: null }));
    expect(handle.replyTerminal).toHaveBeenCalledWith(12, true);
    expect(screen.queryByRole("group", { name: "Polecenie agenta" })).not.toBeInTheDocument();
    settings.useSettingsStore.setState({ values: {} });
  });

  it("shows a command's output in its tool card and full size on request", async () => {
    const { useAgentTerminalsStore } = await import("../../store/agentTerminals");
    useAgentTerminalsStore.setState({ terminals: {} });
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "Uruchamiam testy", kind: "execute", status: "in_progress" });
    act(() => {
      emit({ type: "terminalStarted", terminalId: "term-1", command: "npm test", cwd: "/home/me/app" });
      emit({ type: "terminalOutput", terminalId: "term-1", data: "3 passed\r\n" });
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "r1", content: [{ type: "terminal", terminalId: "term-1" }] });
    const output = screen.getByLabelText("Wyjście polecenia");
    expect(output).toHaveTextContent("npm test");
    expect(output).toHaveTextContent("działa…");
    const key = `${useChatsStore.getState().order[0]}/term-1`; // by conversation, not by tab
    expect(within(output).getByTestId("terminal-view")).toHaveTextContent(key);
    expect(useAgentTerminalsStore.getState().terminals[key].data).toBe("3 passed\r\n");
    act(() => emit({ type: "terminalExit", terminalId: "term-1", exitCode: 0, signal: null }));
    expect(output).toHaveTextContent("kod 0");
    fireEvent.click(within(output).getByText("Otwórz jako terminal"));
    expect(openAgentTerminal).toHaveBeenCalledWith(key, "Uruchamiam testy");
  });

  it("does not offer to open files of an SSH host", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude", profileId: "srv" })} />);
    await ready();
    update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Edytuj", kind: "edit", locations: [{ path: "/srv/app/a.ts", line: 1 }] });
    expect(screen.getByText("a.ts:1")).toBeDisabled();
  });

  it("offers the agent's login methods and logging in from a terminal", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude", profileId: "local:bash", cwd: "/x" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    act(() =>
      emit({
        type: "authRequired",
        message: "Najpierw się zaloguj",
        authMethods: [
          { id: "oauth", name: "Zaloguj przez przeglądarkę" },
          { id: "term", name: "W terminalu", type: "terminal" },
        ],
      }),
    );
    expect(screen.getByText("Najpierw się zaloguj")).toBeInTheDocument();
    expect(screen.queryByText("W terminalu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Zaloguj przez przeglądarkę"));
    expect(handle.authenticate).toHaveBeenCalledWith("oauth");
    fireEvent.click(screen.getByText("Zaloguj w terminalu"));
    expect(openAgent).toHaveBeenCalledWith("claude", { profileId: "local:bash", cwd: "/x" });
  });

  it("explains a missing agent program with its install command", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    act(() => {
      emit({ type: "log", line: "sh: 1: exec: claude-agent-acp: not found" });
      emit({ type: "error", message: "Agent nie odpowiedział na initialize: Agent zakończył działanie" });
      emit({ type: "exited", code: 127, message: "sh: 1: exec: claude-agent-acp: not found" });
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Nie znaleziono programu trybu rozmowy claude-agent-acp w profilu bash");
    expect(alert).toHaveTextContent("npm install -g @agentclientprotocol/claude-agent-acp");
    expect(box()).toBeDisabled();
  });

  it("shows other errors with the agent's log; closing the tab keeps the agent, ending the conversation stops it", async () => {
    const view = render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    act(() => {
      emit({ type: "log", line: "Error: Please set an Auth method" });
      emit({ type: "error", message: "Nie udało się rozpocząć sesji" });
      emit({ type: "exited", code: 1, message: null });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Nie udało się rozpocząć sesji");
    expect(screen.getByText("Log agenta (1)")).toBeInTheDocument();
    view.unmount();
    expect(handle.stop).not.toHaveBeenCalled();
    const [id] = useChatsStore.getState().order;
    endChat(id);
    expect(handle.stop).toHaveBeenCalled();
    expect(useChatsStore.getState().order).toEqual([]);
  });

  it("reports a failed start", async () => {
    startAcp.mockRejectedValueOnce("Nie można uruchomić gemini: brak pliku");
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("brak pliku");
  });

  describe("history", () => {
    const line = (o: object) => JSON.stringify({ t: 1, ...o });
    const update = (u: object) => line({ event: { type: "update", update: u } });
    const transcript = (caps: object) =>
      [
        JSON.stringify({ leverframe: "acp-transcript", version: 1 }),
        line({ event: { type: "initialized", agentInfo: { name: "fake", title: "Fake Agent" }, agentCapabilities: caps, authMethods: [] } }),
        line({ event: { type: "sessionReady", sessionId: "s-old", cwd: "/home/me/app", modes: null, configOptions: null } }),
        line({ sent: "Uruchom testy" }),
        update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId: "term-1" }] }),
        line({ event: { type: "terminalStarted", terminalId: "term-1", command: "npm test", cwd: null } }),
        line({ event: { type: "terminalOutput", terminalId: "term-1", data: "ok 12 testów\r\n" } }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wszystkie **testy** przeszły." } }),
        line({ event: { type: "permission", requestId: 3, toolCall: { title: "Zapis" }, options: [] } }),
        "to nie jest JSON",
        line({ turnEnded: "end_turn" }),
        line({ event: { type: "exited", code: 0, message: null } }),
      ].join("\n");

    it("shows a saved conversation read only and resumes it", async () => {
      readTranscript.mockResolvedValueOnce(transcript({ loadSession: true }));
      render(<AgentChatPanel {...props({ agentId: "claude", profileId: "local:bash", cwd: "/home/me/app", historyId: 5, acpSessionId: "s-old" })} />);
      expect(await screen.findByText("testy", { selector: "strong" })).toBeInTheDocument();
      expect(readTranscript).toHaveBeenCalledWith(5);
      expect(screen.getByText("Uruchom testy")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Historia");
      expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
      // Nothing to answer in the history, nothing to type, and no agent process yet.
      expect(screen.queryByRole("group", { name: "Zgoda" })).toBeNull();
      expect(screen.queryByLabelText("Wiadomość do agenta")).toBeNull();
      expect(startAcp).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Wznów rozmowę"));
      expect(startAcp.mock.calls[0][0]).toMatchObject({
        agentId: "claude",
        profileId: "local:bash",
        cwd: "/home/me/app",
        resume: { sessionId: "s-old", historyId: 5 },
      });
      expect(screen.getByText("Rozmowa wznowiona.")).toBeInTheDocument();
      await ready();
      expect(screen.getByText("Uruchom testy")).toBeInTheDocument();
      send("A teraz lint");
      expect(handle.prompt).toHaveBeenCalledWith("A teraz lint");
    });

    it("offers no resuming when the agent cannot do it", async () => {
      readTranscript.mockResolvedValueOnce(transcript({ loadSession: false, sessionCapabilities: { list: {} } }));
      render(<AgentChatPanel {...props({ agentId: "claude", historyId: 6, acpSessionId: "s-old" })} />);
      expect(await screen.findByText(/nie pozwala wznawiać rozmów/)).toBeInTheDocument();
      expect(screen.queryByText("Wznów rozmowę")).toBeNull();
    });

    it("reports a transcript that cannot be read", async () => {
      readTranscript.mockRejectedValueOnce("Brak pliku nagrania");
      render(<AgentChatPanel {...props({ agentId: "claude", historyId: 7 })} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Nie udało się wczytać rozmowy: Brak pliku nagrania");
    });
  });

  it("opens and deletes the agent's own saved sessions", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    act(() => {
      emit({ type: "initialized", agentInfo: null, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } }, authMethods: [] });
      emit({ type: "sessionReady", sessionId: "s1", cwd: "/home/me/app", modes: null, configOptions: null });
    });
    send("Cześć");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Gotowy"));
    fireEvent.click(screen.getByText("Rozmowy agenta"));
    const list = await screen.findByRole("region", { name: "Rozmowy zapisane przez agenta" });
    expect(await within(list).findByText("Wczorajsza rozmowa")).toBeInTheDocument();
    expect(within(list).getByText("bieżąca")).toBeInTheDocument();

    fireEvent.click(within(list).getByLabelText("Usuń rozmowę Starsza rozmowa u agenta"));
    expect(handle.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByText("Usuń"));
    await waitFor(() => expect(handle.deleteSession).toHaveBeenCalledWith("old-2"));
    await waitFor(() => expect(within(list).queryByText("Starsza rozmowa")).toBeNull());

    const row = within(list).getByText("Wczorajsza rozmowa").closest("li")!;
    fireEvent.click(within(row).getByText("Otwórz"));
    expect(handle.loadSession).toHaveBeenCalledWith("old-1");
    expect(screen.queryByText("Cześć")).toBeNull(); // the replay of the other session starts over
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Napraw testy" } });
    expect(screen.getByText("Napraw testy")).toBeInTheDocument();
  });

  it("reloads open editors without unsaved changes after the agent edits files itself", async () => {
    const clean = { path: "/home/me/app/a.ts", dirty: false, save: vi.fn(), reload: vi.fn(async () => undefined) };
    const dirty = { path: "/home/me/app/b.ts", dirty: true, save: vi.fn(), reload: vi.fn(async () => undefined) };
    useEditorStore.setState({ editors: { "editor:a": clean, "editor:b": dirty } });
    render(<AgentChatPanel {...props({ agentId: "claude", profileId: "local:bash" })} />);
    await ready();
    update({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit", kind: "edit", status: "in_progress", locations: [{ path: "/home/me/app/a.ts" }, { path: "/home/me/app/b.ts" }] });
    expect(clean.reload).not.toHaveBeenCalled();
    update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" });
    expect(clean.reload).toHaveBeenCalledTimes(1);
    expect(dirty.reload).not.toHaveBeenCalled(); // unsaved changes stay; saving shows the conflict
    useEditorStore.setState({ editors: {} });
  });

  it("shows the end of the conversation when its tab is clicked or it is switched to", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });
    log.scrollTop = 100; // the user scrolled up
    act(() => requestChatScroll(useChatsStore.getState().order[0]));
    await waitFor(() => expect(log.scrollTop).toBe(900));
  });

  it("has no list of saved sessions when the agent does not offer one", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude" })} />);
    await ready();
    expect(screen.queryByText("Rozmowy agenta")).toBeNull();
  });
});
