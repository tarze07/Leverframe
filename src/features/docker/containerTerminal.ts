import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useProfilesStore } from "../../store/profiles";
import type { Profile } from "../profiles/profilesClient";
import type { PtySpawnRequest } from "../terminal/ptyClient";
import { openTerminal } from "../../workbench/commands";
import { dockRegistry } from "../../workbench/docks";

export interface PreparedContainer {
  running: boolean;
  /** Started for this terminal. */
  started: boolean;
  /** Working directory in the container (the project folder when it is mounted). */
  workdir: string;
}

const prepare = (profileId: string, cwd: string | undefined, start: boolean) =>
  invoke<PreparedContainer>("docker_prepare_container", { profileId, cwd: cwd ?? null, start });

/**
 * Before a terminal of a container profile starts: the container runs (a stopped one is started
 * by itself, or after asking when the profile says so) and the project folder is known in it.
 * Other profiles pass through. Returns the request to spawn and a note for the terminal.
 */
export async function prepareContainerTerminal(request: PtySpawnRequest): Promise<{ request: PtySpawnRequest; note: string | null }> {
  const profiles = useProfilesStore.getState();
  const profile: Profile | undefined = profiles.byId(request.profileId ?? profiles.defaultProfileId);
  if (profile?.kind !== "container" || !profile.container) return { request, note: null };
  const name = profile.container.name;
  let prepared = await prepare(profile.id, request.cwd, false);
  if (!prepared.running) {
    const yes = await ask(`Kontener ${name} jest zatrzymany. Uruchomić go?`, { title: "Kontener zatrzymany", kind: "info" });
    if (!yes) throw new Error(`kontener ${name} jest zatrzymany`);
    prepared = await prepare(profile.id, request.cwd, true);
  }
  return {
    request: { ...request, profileId: profile.id, containerDir: prepared.workdir },
    note: prepared.started ? `Uruchomiono kontener ${name}` : null,
  };
}

/** The profile of a container (detected or added by the user), if there is one. */
export function profileForContainer(name: string): Profile | undefined {
  return useProfilesStore.getState().profiles.find((p) => p.kind === "container" && p.container?.name === name);
}

/** Adds a container as a user profile (its terminal starts the container when needed). */
export function addContainerProfile(name: string): Promise<Profile> {
  return useProfilesStore.getState().save({
    id: "",
    name,
    kind: "container",
    command: "",
    args: [],
    container: { name, autoStart: true },
    source: "user",
  });
}

/**
 * Opens a terminal in a container, in the project folder when it is mounted there. A container
 * made for Leverframe has a detected profile (the list is detected again if it is new); any other
 * becomes a user profile.
 */
export async function openContainerTerminal(name: string, options: { leverframe: boolean; projectDir: string | null }) {
  const profiles = useProfilesStore.getState();
  await profiles.load();
  let profile = profileForContainer(name);
  if (!profile && options.leverframe) {
    await profiles.refresh();
    profile = profileForContainer(name);
  }
  profile ??= await addContainerProfile(name);
  const id = openTerminal({ params: { profileId: profile.id, cwd: options.projectDir ?? undefined } });
  if (id) dockRegistry.get("panel")?.getPanel(id)?.api.setTitle(profile.name);
  return id;
}
