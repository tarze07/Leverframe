import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { AcpEvent, AcpHandle } from "./acpClient";

vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openAgent = vi.fn();
vi.mock("../../workbench/commands", () => ({ openAgent: (...a: unknown[]) => openAgent(...a) }));

let emit: (e: AcpEvent) => void = () => undefined;
const handle = {
  id: 7,
  prompt: vi.fn<(text: string) => Promise<string>>(async () => "end_turn"),
  cancel: vi.fn(async () => undefined),
  replyPermission: vi.fn(async () => undefined),
  authenticate: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
} satisfies AcpHandle;
const startAcp = vi.fn(async (_req: unknown, onEvent: (e: AcpEvent) => void) => {
  emit = onEvent;
  return handle;
});
vi.mock("./acpClient", () => ({ startAcp: (req: unknown, onEvent: (e: AcpEvent) => void) => startAcp(req, onEvent) }));

import { AgentChatPanel, type AgentChatParams } from "./AgentChatPanel";

const props = (params: AgentChatParams) => ({ params, api: {} }) as unknown as IDockviewPanelProps<AgentChatParams>;
const ready = () =>
  act(() => {
    emit({ type: "initialized", agentInfo: { name: "fake", title: "Fake Agent", version: "1.0" }, agentCapabilities: {}, authMethods: [] });
    emit({ type: "sessionReady", sessionId: "s1", cwd: "/home/me/app", modes: null, configOptions: null });
  });

describe("AgentChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("starts the agent, sends a prompt and shows the streamed answer", async () => {
    let finish: (reason: string) => void = () => undefined;
    handle.prompt.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    render(<AgentChatPanel {...props({ agentId: "gemini", profileId: "local:bash", cwd: "/home/me/app" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    expect(startAcp.mock.calls[0][0]).toEqual({ agentId: "gemini", profileId: "local:bash", cwd: "/home/me/app" });
    expect(screen.getByRole("status")).toHaveTextContent("Łączenie z agentem…");
    await ready();
    expect(screen.getByText("Fake Agent")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Gotowy");

    const box = screen.getByLabelText("Wiadomość do agenta");
    fireEvent.change(box, { target: { value: "Popraw testy" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(handle.prompt).toHaveBeenCalledWith("Popraw testy");
    expect(box).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Agent pracuje…");
    act(() => {
      emit({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Gotowe, " } } });
      emit({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "3 testy." } } });
    });
    expect(screen.getByText("Gotowe, 3 testy.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Stop"));
    expect(handle.cancel).toHaveBeenCalled();
    await act(async () => finish("cancelled"));
    expect(screen.getByText("Przerwano.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Gotowy");
  });

  it("answers permission requests with the agent's options", async () => {
    render(<AgentChatPanel {...props({ agentId: "gemini" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    await ready();
    act(() =>
      emit({
        type: "permission",
        requestId: 3,
        toolCall: { title: "Uruchom npm test" },
        options: [
          { optionId: "yes", name: "Zezwól raz", kind: "allow_once" },
          { optionId: "no", name: "Odmów", kind: "reject_once" },
        ],
      }),
    );
    expect(screen.getByRole("group", { name: "Prośba o zgodę" })).toHaveTextContent("Uruchom npm test");
    fireEvent.click(screen.getByText("Zezwól raz"));
    expect(handle.replyPermission).toHaveBeenCalledWith(3, "yes");
    act(() => emit({ type: "permissionClosed", requestId: 3 }));
    expect(screen.queryByRole("group", { name: "Prośba o zgodę" })).not.toBeInTheDocument();
  });

  it("offers the agent's login methods and logging in from a terminal", async () => {
    render(<AgentChatPanel {...props({ agentId: "claude", profileId: "p1", cwd: "/x" })} />);
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
    expect(screen.queryByText("W terminalu")).not.toBeInTheDocument(); // terminal methods: own button below
    fireEvent.click(screen.getByText("Zaloguj przez przeglądarkę"));
    expect(handle.authenticate).toHaveBeenCalledWith("oauth");
    fireEvent.click(screen.getByText("Zaloguj w terminalu"));
    expect(openAgent).toHaveBeenCalledWith("claude", { profileId: "p1", cwd: "/x" });
  });

  it("shows errors with the agent's log and stops the agent when closed", async () => {
    const view = render(<AgentChatPanel {...props({ agentId: "gemini" })} />);
    await waitFor(() => expect(startAcp).toHaveBeenCalled());
    act(() => {
      emit({ type: "log", line: "Error: Please set an Auth method" });
      emit({ type: "error", message: "Nie udało się rozpocząć sesji" });
      emit({ type: "exited", code: 1, message: null });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Nie udało się rozpocząć sesji");
    expect(screen.getByText("Log agenta (1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Wiadomość do agenta")).toBeDisabled();
    view.unmount();
    expect(handle.stop).toHaveBeenCalled();
  });

  it("reports a failed start", async () => {
    startAcp.mockRejectedValueOnce("Nie można uruchomić gemini: brak pliku");
    render(<AgentChatPanel {...props({ agentId: "gemini" })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("brak pliku");
  });
});
