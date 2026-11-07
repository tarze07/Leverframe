import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "./sessionsClient";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openSessionPlayer = vi.fn();
vi.mock("../../workbench/commands", () => ({ openSessionPlayer: (...a: unknown[]) => openSessionPlayer(...a) }));

import { SessionsView } from "./SessionsView";
import { useSessionsStore } from "../../store/sessions";

const rec = (id: number, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  agentId: "claude",
  agentName: "Claude Code",
  profileId: "local:bash",
  profileName: "bash",
  cwd: "/home/me/app",
  startedAt: new Date(2026, 10, 6, 10, 0).getTime(),
  endedAt: new Date(2026, 10, 6, 10, 5).getTime(),
  exitCode: 0,
  castPath: `/rec/${id}.cast`,
  bytes: 100,
  snippet: null,
  ...extra,
});

function backend(list: (filter: Record<string, unknown>) => SessionRecord[]) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "sessions_info":
        return { recordingEnabled: true, recordingsDir: "/data/recordings" };
      case "sessions_list":
        return list(args!.filter as Record<string, unknown>);
      case "sessions_facets":
        return {
          agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }],
          profiles: [{ id: "local:bash", name: "bash" }],
          cwds: ["/home/me/app"],
        };
      case "sessions_clear":
        return 2;
      default:
        return undefined;
    }
  });
}

describe("SessionsView", () => {
  beforeEach(() => {
    invoke.mockReset();
    openSessionPlayer.mockReset();
    useSessionsStore.setState({
      filters: { query: "", agentId: "", profileId: "", cwd: "", range: "all" },
      sessions: [],
      status: "idle",
      error: null,
    });
  });

  it("lists sessions with agent, profile, duration and folder, and opens the player", async () => {
    backend(() => [rec(1), rec(2, { agentName: "Codex", exitCode: 1 }), rec(3, { endedAt: null })]);
    render(<SessionsView />);
    const [first] = await screen.findAllByRole("listitem", { name: /^Claude Code/ });
    expect(within(first).getByText("5 min 0 s", { exact: false })).toBeInTheDocument();
    expect(within(first).getByText("· app")).toBeInTheDocument();
    expect(screen.getByText("kod 1")).toBeInTheDocument();
    expect(screen.getByText("trwa")).toBeInTheDocument();
    fireEvent.click(within(first).getByText("Claude Code"));
    expect(openSessionPlayer).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "");
  });

  it("searches (debounced) and highlights matches in snippets", async () => {
    backend((f) => (f.query === "npm test" ? [rec(1, { snippet: "Running [[npm]] [[test]] now" })] : [rec(1), rec(2)]));
    render(<SessionsView />);
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByLabelText("Szukaj w sesjach"), { target: { value: "npm test" } });
    const mark = await screen.findByText("npm", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("listitem")).getByText("Claude Code"));
    expect(openSessionPlayer).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "npm test");
  });

  it("passes filters to the backend", async () => {
    backend(() => []);
    render(<SessionsView />);
    await screen.findByText(/Brak nagranych sesji/);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Projekt"), { target: { value: "/home/me/app" } });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "7d" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith("sessions_facets"),
    );
    const lastList = invoke.mock.calls.filter((c) => c[0] === "sessions_list").pop()![1] as { filter: Record<string, unknown> };
    expect(lastList.filter).toMatchObject({ agentId: "codex", cwd: "/home/me/app" });
    expect(typeof lastList.filter.from).toBe("number");
    expect(await screen.findByText("Brak sesji pasujących do filtrów.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Wyczyść filtry"));
    expect(useSessionsStore.getState().filters.agentId).toBe("");
  });

  it("toggles recording, deletes a session and clears history after confirmation", async () => {
    backend(() => [rec(1)]);
    render(<SessionsView />);
    await screen.findByRole("listitem");
    fireEvent.click(screen.getByLabelText("Nagrywaj sesje agentów"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sessions_set_recording", { enabled: false }));

    fireEvent.click(screen.getByLabelText("Usuń sesję"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sessions_delete", { id: 1 }));

    fireEvent.click(screen.getByText("Wyczyść historię…"));
    expect(invoke).not.toHaveBeenCalledWith("sessions_clear");
    await act(async () => fireEvent.click(screen.getByText("Usuń")));
    expect(invoke).toHaveBeenCalledWith("sessions_clear");
  });
});
