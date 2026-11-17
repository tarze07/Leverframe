import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useProfilesStore } from "../../store/profiles";
import type { Profile } from "../profiles/profilesClient";
import type { PtySpawnRequest } from "../terminal/ptyClient";
import { openTerminal } from "../../workbench/commands";
import { dockRegistry } from "../../workbench/docks";
import type { ContainerMount } from "./dockerClient";

export interface PreparedContainer {
  running: boolean;
  /** Started for this terminal. */
  started: boolean;
  /** Working directory in the container (the project folder when it is mounted). */
  workdir: string;
  /** The container's mounts (paths in the container as files of this machine). */
  mounts: ContainerMount[];
  /** On an SSH host: its mounts are that host's folders, not files of this machine. */
  remote: boolean;
}

const prepare = (profileId: string, cwd: string | undefined, start: boolean) =>
  invoke<PreparedContainer>("docker_prepare_container", { profileId, cwd: cwd ?? null, start });

/**
 * The container of a profile, running: a stopped one is started by itself, or after asking when
 * the profile says so (refusing throws). `null` for other profiles.
 */
export async function prepareContainer(profileId: string | null | undefined, cwd: string | null | undefined): Promise<PreparedContainer | null> {
  const profiles = useProfilesStore.getState();
  const profile: Profile | undefined = profiles.byId(profileId ?? profiles.defaultProfileId);
  if (profile?.kind !== "container" || !profile.container) return null;
  const name = profile.container.name;
  let prepared = await prepare(profile.id, cwd ?? undefined, false);
  if (!prepared.running) {
    const yes = await ask(`Kontener ${name} jest zatrzymany. Uruchomić go?`, { title: "Kontener zatrzymany", kind: "info" });
    if (!yes) throw new Error(`kontener ${name} jest zatrzymany`);
    prepared = await prepare(profile.id, cwd ?? undefined, true);
  }
  return prepared;
}

/**
 * Before a terminal of a container profile starts: the container runs (a stopped one is started
 * by itself, or after asking when the profile says so) and the project folder is known in it.
 * Other profiles pass through. Returns the request to spawn and a note for the terminal.
 */
export async function prepareContainerTerminal(request: PtySpawnRequest): Promise<{ request: PtySpawnRequest; note: string | null }> {
  const profiles = useProfilesStore.getState();
  const prepared = await prepareContainer(request.profileId, request.cwd);
  if (!prepared) return { request, note: null };
  const profile = profiles.byId(request.profileId ?? profiles.defaultProfileId);
  return {
    request: { ...request, profileId: profile?.id, containerDir: prepared.workdir },
    note: prepared.started ? `Uruchomiono kontener ${profile?.container?.name ?? ""}` : null,
  };
}

/** The profile of a container (detected or added by the user) on a Docker (`host`: SSH profile id), if there is one. */
export function profileForContainer(name: string, host: string | null = null): Profile | undefined {
  return useProfilesStore
    .getState()
    .profiles.find((p) => p.kind === "container" && p.container?.name === name && (p.container.host ?? null) === host);
}

/** Adds a container as a user profile (its terminal starts the container when needed). */
export function addContainerProfile(name: string, host: string | null = null): Promise<Profile> {
  const ssh = host ? useProfilesStore.getState().byId(host) : undefined;
  return useProfilesStore.getState().save({
    id: "",
    name: ssh ? `${name} (${ssh.name})` : name,
    kind: "container",
    command: "",
    args: [],
    container: host ? { name, autoStart: true, host } : { name, autoStart: true },
    source: "user",
  });
}

/**
 * Opens a terminal in a container, in the project folder when it is mounted there. A container
 * made for Leverframe has a detected profile (the list is detected again if it is new); any other
 * becomes a user profile.
 */
export async function openContainerTerminal(name: string, options: { leverframe: boolean; projectDir: string | null; host?: string | null }) {
  const host = options.host ?? null;
  const profiles = useProfilesStore.getState();
  await profiles.load();
  let profile = profileForContainer(name, host);
  if (!profile && options.leverframe) {
    await profiles.refresh();
    profile = profileForContainer(name, host);
  }
  profile ??= await addContainerProfile(name, host);
  // On an SSH host the folders of this machine mean nothing (the container has the host's).
  const id = openTerminal({ params: { profileId: profile.id, cwd: host ? undefined : (options.projectDir ?? undefined) } });
  if (id) dockRegistry.get("panel")?.getPanel(id)?.api.setTitle(profile.name);
  return id;
}
