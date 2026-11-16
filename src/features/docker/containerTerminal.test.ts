import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../profiles/profilesClient";

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
const ask = vi.fn(async () => true);
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: () => ask() }));
const openTerminal = vi.fn<(o: unknown) => string | null>(() => "terminal-1");
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
vi.mock("../../workbench/commands", () => ({ openTerminal: (o: unknown) => openTerminal(o) }));
vi.mock("../../workbench/docks", () => ({ dockRegistry: { get: () => null } }));

import { openContainerTerminal, prepareContainerTerminal } from "./containerTerminal";
import { useProfilesStore } from "../../store/profiles";

const container = (id: string, name: string, source: Profile["source"] = "detected"): Profile => ({
  id,
  name,
  kind: "container",
  command: "",
  args: [],
  container: { name, autoStart: false },
  source,
});
const local: Profile = { id: "local:bash", name: "bash", kind: "local", command: "/bin/bash", args: [], source: "detected" };
const request = { cols: 80, rows: 24 };

describe("container terminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProfilesStore.setState({ profiles: [local, container("container:sklep", "sklep")], defaultProfileId: "local:bash", status: "ready" });
  });

  it("leaves other profiles alone", async () => {
    expect(await prepareContainerTerminal({ ...request, profileId: "local:bash" })).toEqual({ request: { ...request, profileId: "local:bash" }, note: null });
    expect(await prepareContainerTerminal(request)).toEqual({ request, note: null }); // default profile
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens a running container in the project folder", async () => {
    invoke.mockResolvedValueOnce({ running: true, started: false, workdir: "/workspace/src" });
    const r = await prepareContainerTerminal({ ...request, profileId: "container:sklep", cwd: "/home/me/sklep/src" });
    expect(invoke).toHaveBeenCalledWith("docker_prepare_container", { profileId: "container:sklep", cwd: "/home/me/sklep/src", start: false });
    expect(r).toEqual({ request: { ...request, profileId: "container:sklep", cwd: "/home/me/sklep/src", containerDir: "/workspace/src" }, note: null });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before it starts a stopped container", async () => {
    invoke.mockResolvedValueOnce({ running: false, started: false, workdir: "/workspace" });
    invoke.mockResolvedValueOnce({ running: true, started: true, workdir: "/workspace" });
    const r = await prepareContainerTerminal({ ...request, profileId: "container:sklep" });
    expect(ask).toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith("docker_prepare_container", { profileId: "container:sklep", cwd: null, start: true });
    expect(r.note).toBe("Uruchomiono kontener sklep");

    invoke.mockResolvedValueOnce({ running: false, started: false, workdir: "/workspace" });
    ask.mockResolvedValueOnce(false);
    await expect(prepareContainerTerminal({ ...request, profileId: "container:sklep" })).rejects.toThrow("kontener sklep jest zatrzymany");
  });

  it("opens a terminal with the container's profile, made when it has none", async () => {
    await openContainerTerminal("sklep", { leverframe: true, projectDir: "/home/me/sklep" });
    expect(openTerminal).toHaveBeenCalledWith({ params: { profileId: "container:sklep", cwd: "/home/me/sklep" } });

    // A new Leverframe container: detected again.
    invoke.mockImplementation(async (cmd) =>
      cmd === "profiles_refresh"
        ? { profiles: [local, container("container:nowy", "nowy")], defaultProfileId: "local:bash" }
        : undefined,
    );
    await openContainerTerminal("nowy", { leverframe: true, projectDir: null });
    expect(openTerminal).toHaveBeenLastCalledWith({ params: { profileId: "container:nowy", cwd: undefined } });

    // Another container: added as a user profile.
    invoke.mockImplementation(async (cmd, args) =>
      cmd === "profile_save"
        ? { ...(args?.profile as Profile), id: "user-1" }
        : { profiles: [local, container("container:nowy", "nowy")], defaultProfileId: "local:bash" },
    );
    await openContainerTerminal("baza", { leverframe: false, projectDir: null });
    expect(invoke).toHaveBeenCalledWith("profile_save", {
      profile: expect.objectContaining({ kind: "container", name: "baza", container: { name: "baza", autoStart: true } }),
    });
    expect(openTerminal).toHaveBeenLastCalledWith({ params: { profileId: "user-1", cwd: undefined } });
    invoke.mockReset();
  });
});
