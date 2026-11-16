import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openFile: (p: string) => openFile(p),
  logFilePath: (f: string) => f,
  openCommandInTerminal: vi.fn(),
}));
const inspect = vi.fn<(name: string) => Promise<{ mounts: object[] }>>(async () => ({
  mounts: [{ kind: "bind", source: "/home/me/sklep", destination: "/workspace", name: null, readWrite: true }],
}));
vi.mock("../docker/dockerClient", () => ({ dockerClient: { inspect: (n: string) => inspect(n) } }));

import { openLogFile } from "./AgentLogPanel";
import { useProfilesStore } from "../../store/profiles";

describe("openLogFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProfilesStore.setState({
      profiles: [{ id: "container:sklep", name: "sklep", kind: "container", command: "docker", args: [], source: "detected", container: { name: "sklep-agenci", autoStart: true } }],
    });
  });

  it("opens a file from a container's log on this machine", async () => {
    await openLogFile("src/app.ts", { source: "docker:container:sklep", cwd: "/workspace" });
    expect(inspect).toHaveBeenCalledWith("sklep-agenci");
    expect(openFile).toHaveBeenCalledWith("/home/me/sklep/src/app.ts");
  });

  it("says when the file is only in the container", async () => {
    await expect(openLogFile("/root/notes.md", { source: "docker:container:sklep", cwd: "/workspace" })).rejects.toThrow("tylko w kontenerze");
    await expect(openLogFile("a.ts", { source: "docker:user-9", cwd: null })).rejects.toThrow("już nie istnieje");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("opens other sources as before", async () => {
    await openLogFile("/home/me/a.ts", { source: "local", cwd: null });
    expect(openFile).toHaveBeenCalledWith("/home/me/a.ts");
    expect(inspect).not.toHaveBeenCalled();
  });
});
