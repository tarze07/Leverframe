import { create } from "zustand";
import { isTauri } from "../lib/tauri";
import { profilesClient, type Profile, type ProfilesState } from "../features/profiles/profilesClient";

type Status = "idle" | "loading" | "ready" | "error";

interface ProfilesStore {
  profiles: Profile[];
  defaultProfileId: string | null;
  status: Status;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  save: (profile: Profile) => Promise<Profile>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  byId: (id: string | undefined | null) => Profile | undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useProfilesStore = create<ProfilesStore>()((set, get) => {
  const apply = (state: ProfilesState) =>
    set({ profiles: state.profiles, defaultProfileId: state.defaultProfileId, status: "ready", error: null });

  const run = async (fetch: () => Promise<ProfilesState>) => {
    if (!isTauri()) {
      set({ status: "ready", profiles: [], defaultProfileId: null });
      return;
    }
    set({ status: "loading", error: null });
    try {
      apply(await fetch());
    } catch (e) {
      set({ status: "error", error: message(e) });
    }
  };

  return {
    profiles: [],
    defaultProfileId: null,
    status: "idle",
    error: null,
    load: async (force = false) => {
      if (!force && get().status !== "idle") return;
      await run(profilesClient.list);
    },
    refresh: () => run(profilesClient.refresh),
    save: async (profile) => {
      const saved = await profilesClient.save(profile);
      await run(profilesClient.list);
      return saved;
    },
    remove: async (id) => {
      await profilesClient.remove(id);
      await run(profilesClient.list);
    },
    setDefault: async (id) => {
      await profilesClient.setDefault(id);
      set({ defaultProfileId: id });
    },
    byId: (id) => (id ? get().profiles.find((p) => p.id === id) : undefined),
  };
});
