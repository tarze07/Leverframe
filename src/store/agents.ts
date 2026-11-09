import { create } from "zustand";
import { isTauri } from "../lib/tauri";
import { agentsClient, type Agent, type AgentStatus } from "../features/agents/agentsClient";

type DetectState =
  | { status: "loading" }
  | { status: "ready"; results: AgentStatus[] }
  | { status: "error"; error: string };

interface AgentsStore {
  agents: Agent[];
  errors: string[];
  configPath: string | null;
  loaded: boolean;
  /** Profile chosen in the Agents panel; `null` = the default profile. */
  profileId: string | null;
  projectDir: string | null;
  /** Recently used project folders (most recent first). */
  recentDirs: string[];
  /** Directory on the host for each SSH profile. */
  remoteDirs: Record<string, string>;
  detection: Record<string, DetectState>;
  load: () => Promise<void>;
  setProfile: (profileId: string | null) => void;
  detect: (profileId: string, force?: boolean) => Promise<void>;
  setProjectDir: (path: string | null) => Promise<void>;
  setRemoteDir: (profileId: string, path: string | null) => Promise<void>;
  agentById: (id: string | null | undefined) => Agent | undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  agents: [],
  errors: [],
  configPath: null,
  loaded: false,
  profileId: null,
  projectDir: null,
  recentDirs: [],
  remoteDirs: {},
  detection: {},
  load: async () => {
    if (get().loaded || !isTauri()) return;
    set({ loaded: true });
    try {
      const [state, projectDir, recentDirs, remoteDirs] = await Promise.all([
        agentsClient.list(),
        agentsClient.projectDir(),
        agentsClient.recentDirs().catch(() => []),
        agentsClient.remoteDirs().catch(() => ({})),
      ]);
      set({ agents: state.agents, errors: state.errors, configPath: state.configPath, projectDir, recentDirs, remoteDirs });
    } catch (e) {
      set({ errors: [message(e)], loaded: false });
    }
  },
  setProfile: (profileId) => set({ profileId }),
  detect: async (profileId, force = false) => {
    const current = get().detection[profileId];
    if (!force && current && current.status !== "error") return;
    set((s) => ({ detection: { ...s.detection, [profileId]: { status: "loading" } } }));
    try {
      const results = await agentsClient.detect(profileId, force);
      set((s) => ({ detection: { ...s.detection, [profileId]: { status: "ready", results } } }));
    } catch (e) {
      set((s) => ({ detection: { ...s.detection, [profileId]: { status: "error", error: message(e) } } }));
    }
  },
  setProjectDir: async (path) => {
    const projectDir = await agentsClient.setProjectDir(path);
    set({ projectDir });
    const recentDirs = await agentsClient.recentDirs().catch(() => null);
    if (recentDirs) set({ recentDirs });
  },
  setRemoteDir: async (profileId, path) => {
    const dir = await agentsClient.setRemoteDir(profileId, path);
    set((s) => {
      const remoteDirs = { ...s.remoteDirs };
      if (dir) remoteDirs[profileId] = dir;
      else delete remoteDirs[profileId];
      return { remoteDirs };
    });
  },
  agentById: (id) => (id ? get().agents.find((a) => a.id === id) : undefined),
}));
