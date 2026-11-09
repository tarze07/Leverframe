import { invoke } from "@tauri-apps/api/core";

export interface InstallHint {
  platform: "unix" | "windows" | "any";
  command: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string | null;
  commands: string[];
  docsUrl?: string | null;
  install: InstallHint[];
}

export interface AgentsState {
  agents: Agent[];
  errors: string[];
  configPath: string;
}

export interface AgentStatus {
  id: string;
  installed: boolean;
  command: string | null;
  version: string | null;
}

export const agentsClient = {
  list: () => invoke<AgentsState>("agents_list"),
  detect: (profileId: string, force = false) => invoke<AgentStatus[]>("agents_detect", { profileId, force }),
  projectDir: () => invoke<string | null>("settings_project_dir"),
  setProjectDir: (path: string | null) => invoke<string | null>("settings_set_project_dir", { path }),
  recentDirs: () => invoke<string[]>("settings_recent_project_dirs"),
  remoteDirs: () => invoke<Record<string, string>>("settings_remote_dirs"),
  setRemoteDir: (profileId: string, path: string | null) =>
    invoke<string | null>("settings_set_remote_dir", { profileId, path }),
};

/** Last path segment, for compact display of the project folder. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
