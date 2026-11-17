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
  /** Conversation mode (Agent Client Protocol), if the agent has one. */
  acp?: AcpInfo | null;
  /** Arguments added after the command in a terminal (settings). */
  args?: string[];
  /** Environment of the agent, terminal and conversation mode (settings). */
  env?: Record<string, string>;
  /** Hidden in the Agents view (settings). */
  hidden?: boolean;
  /** Defined by Leverframe (not only in the user's agents.json). */
  builtin?: boolean;
  /** The built-in conversation-mode command line. */
  defaultAcp?: string[] | null;
}

/** What the agent's settings form saves (an override in the user's agents.json). */
export interface AgentSettings {
  args: string[];
  env: Record<string, string>;
  /** Conversation-mode program and arguments; null = the built-in ones. */
  acp: string[] | null;
  hidden: boolean;
}

export interface AcpInfo {
  command: string;
  args: string[];
  /** Adapter install hints for this platform. */
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
  /** Whether the ACP program is available; null/undefined for agents without ACP mode. */
  acp?: boolean | null;
}

export const agentsClient = {
  list: () => invoke<AgentsState>("agents_list"),
  detect: (profileId: string, force = false) => invoke<AgentStatus[]>("agents_detect", { profileId, force }),
  saveSettings: (id: string, settings: AgentSettings) => invoke<AgentsState>("agents_save_settings", { id, settings }),
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
