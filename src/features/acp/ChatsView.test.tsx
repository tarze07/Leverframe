import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpEvent, AcpHandle } from "./acpClient";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";

vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const emitters: ((e: AcpEvent) => void)[] = [];
const stop = vi.fn(async () => undefined);
vi.mock("./acpClient", () => ({
  startAcp: vi.fn(async (_req: unknown, onEvent: (e: AcpEvent) => void) => {
    emitters.push(onEvent);
    return { id: emitters.length, stop, prompt: vi.fn(() => new Promise(() => undefined)) } as unknown as AcpHandle;
  }),
}));
const openChatPanel = vi.fn();
vi.mock("../../workbench/commands", async (original) => ({
  ...(await original<typeof import("../../workbench/commands")>()),
  openChatPanel: (...a: unknown[]) => openChatPanel(...a),
}));

import { ChatsView } from "./ChatsView";
import { createChat, endAllChats, sendChat, useChatsStore } from "../../store/chats";

const ready = (i: number) =>
  act(() => {
    emitters[i]({ type: "initialized", agentInfo: { name: "fake", title: "Claude Agent" }, agentCapabilities: {}, authMethods: [] });
    emitters[i]({ type: "sessionReady", sessionId: `s${i}`, cwd: "/home/me/app", modes: null, configOptions: null });
  });

describe("ChatsView", () => {
  beforeEach(async () => {
    endAllChats();
    emitters.length = 0;
    vi.clearAllMocks();
    useAgentsStore.setState({ agents: [{ id: "claude", name: "Claude Code", commands: ["claude"], install: [] }] });
    useProfilesStore.setState({
      profiles: [{ id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" }],
      defaultProfileId: "local:bash",
    } as Partial<ReturnType<typeof useProfilesStore.getState>>);
  });

  it("points to the Agents view when no conversation is open", () => {
    render(<ChatsView />);
    expect(screen.getByText(/Brak otwartych rozmów/)).toBeInTheDocument();
  });

  it("lists open conversations with their state, opens them and ends them", async () => {
    const first = createChat({ agentId: "claude", cwd: "/home/me/app" });
    const second = createChat({ agentId: "claude", profileId: "local:bash", cwd: "/home/me/shop" });
    await vi.waitFor(() => expect(emitters).toHaveLength(2));
    ready(0);
    ready(1);
    act(() => sendChat(first, "Popraw testy w module płatności"));
    act(() =>
      emitters[1]({ type: "permission", requestId: 1, toolCall: { title: "Edytuj README.md" }, options: [{ optionId: "a", name: "Zezwól", kind: "allow_once" }] }),
    );
    render(<ChatsView />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Newest first; the one waiting for a decision says so.
    expect(rows[0]).toHaveTextContent("czeka na decyzję");
    expect(rows[0]).toHaveTextContent("shop");
    expect(rows[1]).toHaveTextContent("Popraw testy w module płatności");
    expect(rows[1]).toHaveTextContent("Agent pracuje…");

    fireEvent.click(within(rows[1]).getByText("Claude Agent"));
    expect(openChatPanel).toHaveBeenCalledWith(first);

    // A working agent is ended only after confirmation.
    fireEvent.click(within(rows[1]).getByLabelText("Zakończ rozmowę"));
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(within(rows[1]).getByText("Zakończ"));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(useChatsStore.getState().order).toEqual([second]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("removes a conversation whose agent has ended without asking", async () => {
    const id = createChat({ agentId: "claude" });
    await vi.waitFor(() => expect(emitters).toHaveLength(1));
    ready(0);
    act(() => emitters[0]({ type: "exited", code: 0, message: null }));
    render(<ChatsView />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Agent zakończył działanie");
    fireEvent.click(screen.getByLabelText("Usuń z listy"));
    expect(useChatsStore.getState().chats[id]).toBeUndefined();
  });
});
