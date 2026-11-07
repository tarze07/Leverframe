import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { LogDetail, LogSummary } from "./agentLogsClient";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
const listeners: Record<string, () => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    listeners[name] = cb;
    return () => delete listeners[name];
  }),
}));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const writeText = vi.fn(async (t: string) => void t);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => writeText(t) }));
const openAgentLog = vi.fn();
const openCommandInTerminal = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openAgentLog: (...a: unknown[]) => openAgentLog(...a),
  openCommandInTerminal: (...a: unknown[]) => openCommandInTerminal(...a),
}));

import { AgentLogsList } from "./AgentLogsList";
import { AgentLogPanel, type AgentLogParams } from "./AgentLogPanel";
import { useAgentLogsStore } from "../../store/agentLogs";
import { useProfilesStore } from "../../store/profiles";

const now = Date.now();
const summary = (extra: Partial<LogSummary>): LogSummary => ({
  agent: "claude",
  nativeId: "5f1c2a9e-1111",
  title: "Napraw testy płatności",
  cwd: "/home/me/shop",
  gitBranch: "main",
  startedAt: now - 60_000,
  updatedAt: now,
  path: "/home/me/.claude/projects/-home-me-shop/5f1c2a9e.jsonl",
  source: "local",
  size: 100,
  ...extra,
});

const detail: LogDetail = {
  summary: summary({}),
  skippedLines: 1,
  entries: [
    { kind: "user", text: "Napraw testy płatności", ts: now },
    { kind: "thinking", text: "Ukryte rozumowanie", ts: now },
    { kind: "toolCall", id: "t1", name: "Bash", input: { command: "npm test" }, command: "npm test", files: [], ts: now },
    { kind: "toolResult", callId: "t1", output: "Exit code 1\nFAIL payments", isError: true, exitCode: 1, ts: now },
    { kind: "toolCall", id: "t2", name: "Edit", input: { file_path: "/home/me/shop/src/pay.ts" }, command: null, files: ["/home/me/shop/src/pay.ts"], ts: now },
    { kind: "toolResult", callId: "t2", output: "The file has been updated.", isError: false, exitCode: null, ts: now },
    { kind: "assistant", text: "Gotowe, testy przechodzą.", ts: now },
  ],
};

describe("AgentLogsList", () => {
  beforeEach(() => {
    invoke.mockReset();
    openAgentLog.mockReset();
    useAgentLogsStore.setState({ source: "local", logs: [], status: "idle", error: null });
    useProfilesStore.setState({
      profiles: [{ id: "wsl:Ubuntu", name: "Ubuntu", kind: "wsl", command: "wsl.exe", args: [], source: "detected" }],
      defaultProfileId: null,
      status: "ready",
      error: null,
    });
    invoke.mockImplementation(async (cmd: string, args?: { source: string }) => {
      if (cmd !== "agent_logs_list") return undefined;
      if (args?.source === "wsl:Ubuntu") return [summary({ agent: "codex", title: "Zadanie w WSL", source: "wsl:Ubuntu", path: "/w" })];
      return [summary({}), summary({ agent: "codex", nativeId: "0199", title: "Rate limit", cwd: "/home/me/api", gitBranch: null, path: "/c", updatedAt: now - 40 * 86_400_000 })];
    });
  });

  it("lists conversations, filters them and opens the timeline", async () => {
    render(<AgentLogsList />);
    expect(await screen.findByText("Napraw testy płatności")).toBeInTheDocument();
    expect(screen.getByText("Rate limit")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "codex" } });
    expect(screen.queryByText("Napraw testy płatności")).toBeNull();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "30d" } });
    expect(screen.queryByText("Rate limit")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filtruj rozmowy"), { target: { value: "shop" } });
    fireEvent.click(screen.getByText("Napraw testy płatności"));
    expect(openAgentLog).toHaveBeenCalledWith(expect.objectContaining({ nativeId: "5f1c2a9e-1111" }));
  });

  it("switches to a WSL source and refreshes when local logs change", async () => {
    render(<AgentLogsList />);
    await screen.findByText("Rate limit");
    fireEvent.change(screen.getByLabelText("Źródło"), { target: { value: "wsl:Ubuntu" } });
    expect(await screen.findByText("Zadanie w WSL")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("agent_logs_list", { source: "wsl:Ubuntu" });
    fireEvent.change(screen.getByLabelText("Źródło"), { target: { value: "local" } });
    await screen.findByText("Rate limit");
    const calls = invoke.mock.calls.length;
    await waitFor(() => expect(listeners["agent-logs-changed"]).toBeDefined());
    await act(async () => listeners["agent-logs-changed"]());
    expect(invoke.mock.calls.length).toBe(calls + 1);
  });
});

describe("AgentLogPanel", () => {
  const props = { params: { source: "local", path: detail.summary.path } } as IDockviewPanelProps<AgentLogParams>;

  beforeEach(() => {
    invoke.mockReset();
    openCommandInTerminal.mockReset();
    invoke.mockImplementation(async (cmd: string) => (cmd === "agent_log_read" ? detail : undefined));
  });

  it("shows the timeline with commands, exit codes and changed files", async () => {
    render(<AgentLogPanel {...props} />);
    const command = await screen.findByRole("listitem", { name: "Polecenie npm test" });
    expect(within(command).getByText("kod 1")).toBeInTheDocument();
    expect(within(command).getByText(/FAIL payments/)).toBeVisible(); // failed output expanded
    expect(screen.getByText("1 polecenie", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/1 zmieniony plik/)).toBeInTheDocument();
    expect(screen.getByText("· 1 z błędem")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Zmienione pliki" })).getByText("/home/me/shop/src/pay.ts")).toBeInTheDocument();
    expect(screen.queryByText("Ukryte rozumowanie")).toBeNull();
    fireEvent.click(screen.getByLabelText("Pokaż rozumowanie"));
    expect(screen.getByText("Ukryte rozumowanie")).toBeInTheDocument();
    expect(screen.getByText("pominięte: 1 wiersz")).toBeInTheDocument();
  });

  it("copies, re-types and resumes", async () => {
    render(<AgentLogPanel {...props} />);
    const command = await screen.findByRole("listitem", { name: "Polecenie npm test" });
    fireEvent.click(within(command).getByLabelText("Kopiuj polecenie"));
    expect(writeText).toHaveBeenCalledWith("npm test");
    fireEvent.click(within(command).getByLabelText("Wpisz w nowym terminalu (bez uruchamiania)"));
    expect(openCommandInTerminal).toHaveBeenCalledWith({ command: "npm test", source: "local", cwd: "/home/me/shop", submit: false });
    fireEvent.click(screen.getByText("Wznów sesję"));
    expect(openCommandInTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "claude --resume 5f1c2a9e-1111", submit: true }),
    );
  });

  it("filters to commands only", async () => {
    render(<AgentLogPanel {...props} />);
    await screen.findByText("Gotowe, testy przechodzą.");
    fireEvent.click(screen.getByLabelText("Tylko polecenia"));
    expect(screen.queryByText("Gotowe, testy przechodzą.")).toBeNull();
    expect(screen.getByRole("listitem", { name: "Polecenie npm test" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Zmienione pliki" })).toBeNull();
  });

  it("shows read errors", async () => {
    invoke.mockImplementation(async () => {
      throw "Plik leży poza katalogami logów agentów";
    });
    render(<AgentLogPanel {...props} />);
    expect(await screen.findByText("Plik leży poza katalogami logów agentów")).toBeInTheDocument();
  });
});
