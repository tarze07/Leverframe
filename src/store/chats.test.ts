import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpEvent, AcpHandle } from "../features/acp/acpClient";
import { useProfilesStore } from "./profiles";

vi.mock("../lib/tauri", () => ({ isTauri: () => true }));
const emitters: ((e: AcpEvent) => void)[] = [];
const startAcp = vi.fn(async (_req: unknown, onEvent: (e: AcpEvent) => void) => {
  emitters.push(onEvent);
  return { id: emitters.length, stop: vi.fn(async () => undefined) } as unknown as AcpHandle;
});
vi.mock("../features/acp/acpClient", () => ({ startAcp: (...a: Parameters<typeof startAcp>) => startAcp(...a) }));
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
const ask = vi.fn<(message: string) => Promise<boolean>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (message: string) => ask(message) }));
vi.mock("../features/terminal/keys", async (original) => ({
  ...(await original<typeof import("../features/terminal/keys")>()),
  isWindows: () => false,
}));

import { chatById, chatToLocal, createChat, endAllChats } from "./chats";

const mounts = [
  { kind: "bind", source: "/home/me/sklep", destination: "/workspace", name: null, readWrite: true },
  { kind: "volume", source: "/var/lib/docker/volumes/h/_data", destination: "/root", name: "h", readWrite: true },
];
const prepared = (running: boolean) => ({ running, started: running, workdir: "/workspace", mounts });

describe("conversations in a container", () => {
  beforeEach(() => {
    endAllChats();
    emitters.length = 0;
    vi.clearAllMocks();
    useProfilesStore.setState({
      profiles: [
        { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" },
        { id: "container:sklep", name: "sklep", kind: "container", command: "docker", args: [], source: "detected", container: { name: "sklep", autoStart: false } },
      ],
      defaultProfileId: "local:bash",
    } as Partial<ReturnType<typeof useProfilesStore.getState>>);
  });

  it("starts a stopped container after asking, then the agent; maps its paths through the mounts", async () => {
    invoke.mockImplementation(async (_cmd, args) => prepared((args as { start: boolean }).start));
    ask.mockResolvedValue(true);
    const id = createChat({ agentId: "claude", profileId: "container:sklep", cwd: "/home/me/sklep" });
    await vi.waitFor(() => expect(startAcp).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith("Kontener sklep jest zatrzymany. Uruchomić go?");
    expect(invoke).toHaveBeenLastCalledWith("docker_prepare_container", { profileId: "container:sklep", cwd: "/home/me/sklep", start: true });
    expect(startAcp.mock.calls[0][0]).toMatchObject({ agentId: "claude", profileId: "container:sklep", cwd: "/home/me/sklep" });

    emitters[0]({ type: "sessionReady", sessionId: "s1", cwd: "/workspace", modes: null, configOptions: null });
    expect(chatToLocal(id, "/workspace/src/app.ts")).toBe("/home/me/sklep/src/app.ts");
    expect(chatToLocal(id, "src/app.ts")).toBe("/home/me/sklep/src/app.ts");
    // Only in the container (a volume is not a folder of this machine).
    expect(chatToLocal(id, "/root/.claude.json")).toBeNull();
    expect(chatToLocal(id, "/etc/hosts")).toBeNull();
  });

  it("does not start the agent when the user keeps the container stopped", async () => {
    invoke.mockResolvedValue(prepared(false));
    ask.mockResolvedValue(false);
    const id = createChat({ agentId: "claude", profileId: "container:sklep", cwd: "/home/me/sklep" });
    await vi.waitFor(() => expect(chatById(id)?.state.error).toMatch(/kontener sklep jest zatrzymany/));
    expect(startAcp).not.toHaveBeenCalled();
  });

  it("starts other profiles at once", () => {
    createChat({ agentId: "claude", cwd: "/home/me/app" });
    expect(startAcp).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a conversation started on a task (#107)", () => {
  beforeEach(() => {
    endAllChats();
    emitters.length = 0;
    vi.clearAllMocks();
  });

  it("sends its first message with the task file once the agent is ready, only once", async () => {
    const prompt = vi.fn(async () => "end_turn");
    startAcp.mockImplementationOnce(async (_req: unknown, onEvent: (e: AcpEvent) => void) => {
      emitters.push(onEvent);
      return { id: 1, prompt, stop: vi.fn(async () => undefined) } as unknown as AcpHandle;
    });
    const resource = { uri: "file:///home/me/sklep/.leverframe/tasks/1-a.md", name: "1-a.md" };
    const id = createChat({ agentId: "claude", cwd: "/home/me/sklep", initialPrompt: { text: "Wykonaj zadanie", resource } });
    await vi.waitFor(() => expect(emitters).toHaveLength(1));
    // Not before the session is ready.
    expect(prompt).not.toHaveBeenCalled();
    emitters[0]({ type: "sessionReady", sessionId: "s1", cwd: "/home/me/sklep", modes: null, configOptions: null });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("Wykonaj zadanie", resource));
    expect(chatById(id)?.params.initialPrompt).toBeNull();
    emitters[0]({ type: "sessionReady", sessionId: "s1", cwd: "/home/me/sklep", modes: null, configOptions: null });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
