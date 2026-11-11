import type { DockviewApi } from "dockview-react";
import { useUiStore } from "../store/ui";
import { useProfilesStore } from "../store/profiles";
import { useAgentsStore } from "../store/agents";
import { editorPanelId } from "../store/editor";
import { baseName, joinPath } from "../features/editor/fsClient";
import { isWindows } from "../features/terminal/keys";
import type { SessionRecord } from "../features/sessions/sessionsClient";
import { LOG_AGENT_NAMES, type LogSummary } from "../features/sessions/agentLogsClient";
import { terminalRegistry } from "../features/terminal/registry";
import type { TerminalPanelParams } from "../features/terminal/TerminalPanel";
import { dockRegistry, type DockId } from "./docks";

let counter = 0;
const newPanelId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export interface OpenTerminalOptions {
  dock?: DockId;
  /** Open next to the active terminal instead of as a new tab. */
  split?: "right" | "below";
  params?: TerminalPanelParams;
}

/** Adds a terminal panel to a dock. Returns the new panel id. */
export function addTerminalPanel(api: DockviewApi, { dock = "panel", split, params }: OpenTerminalOptions = {}): string {
  const id = newPanelId("terminal");
  const reference = api.activePanel;
  api.addPanel({
    id,
    component: "terminal",
    title: "Terminal",
    params: { ...params, dock },
    // Keep the xterm DOM alive while the tab is hidden (no re-attach / re-fit glitches).
    renderer: "always",
    position: split && reference ? { referencePanel: reference.id, direction: split } : undefined,
  });
  return id;
}

/** Opens a new terminal tab (bottom panel by default). Returns the panel id, or null if the dock is not ready. */
export function openTerminal(options: OpenTerminalOptions = {}): string | null {
  const dock = options.dock ?? "panel";
  if (dock === "panel") useUiStore.getState().setBottomPanelVisible(true);
  const api = dockRegistry.get(dock);
  return api ? addTerminalPanel(api, { ...options, dock }) : null;
}

/** Opens a terminal for a profile (default profile when `profileId` is omitted). */
export function openProfile(profileId?: string, options: Omit<OpenTerminalOptions, "params"> = {}): string | null {
  const title = useProfilesStore.getState().byId(profileId)?.name;
  const id = openTerminal({ ...options, params: profileId ? { profileId } : {} });
  if (id && title) dockRegistry.get(options.dock ?? "panel")?.getPanel(id)?.api.setTitle(title);
  return id;
}

/** Opens a terminal in a profile (default when omitted) and starts an agent in it. */
export function openAgent(agentId: string, options: { profileId?: string | null; cwd?: string | null; split?: "right" | "below" } = {}) {
  const profileId = options.profileId ?? undefined;
  const agent = useAgentsStore.getState().agentById(agentId);
  const profile = useProfilesStore.getState().byId(profileId ?? useProfilesStore.getState().defaultProfileId);
  const id = openTerminal({
    split: options.split,
    params: { profileId, agentId, cwd: options.cwd ?? undefined },
  });
  if (id && agent) {
    dockRegistry.get("panel")?.getPanel(id)?.api.setTitle(profile ? `${agent.name} · ${profile.name}` : agent.name);
  }
  return id;
}

let chatCounter = 0;

/** Opens a conversation with an agent in ACP mode, in the editor area (a new agent process). */
export function openAgentChat(agentId: string, options: { profileId?: string | null; cwd?: string | null } = {}) {
  const api = dockRegistry.get("main");
  if (!api) return null;
  const agent = useAgentsStore.getState().agentById(agentId);
  const profile = useProfilesStore.getState().byId(options.profileId ?? useProfilesStore.getState().defaultProfileId);
  const id = `chat-${agentId}-${Date.now()}-${++chatCounter}`;
  api.addPanel({
    id,
    component: "agentChat",
    // "rozmowa" tells it apart from the same agent in a terminal tab.
    title: [agent?.name ?? agentId, "rozmowa", profile?.name].filter(Boolean).join(" · "),
    params: { agentId, profileId: options.profileId ?? null, cwd: options.cwd ?? null },
  });
  return id;
}

/** Opens (or focuses) the player for a recorded session in the editor area. */
export function openSessionPlayer(session: SessionRecord, query?: string) {
  const api = dockRegistry.get("main");
  if (!api) return null;
  const id = `session-${session.id}`;
  const existing = api.getPanel(id);
  if (existing && !query) {
    existing.api.setActive();
    return id;
  }
  existing?.api.close();
  const when = new Date(session.startedAt).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
  api.addPanel({
    id,
    component: "session",
    title: `${session.agentName ?? "Sesja"} · ${when}`,
    params: { sessionId: session.id, query: query?.trim() || undefined },
  });
  return id;
}

/** POSIX single-quoting: `it's` → `'it'\''s'`. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Terminal profile matching a log source: the WSL distribution, or the default local profile. */
export function profileForSource(source: string): string | undefined {
  const { profiles, defaultProfileId } = useProfilesStore.getState();
  if (source.startsWith("wsl:")) return profiles.some((p) => p.id === source) ? source : undefined;
  if (source.startsWith("ssh:")) {
    const id = source.slice(4);
    return profiles.some((p) => p.id === id) ? id : undefined;
  }
  const def = profiles.find((p) => p.id === defaultProfileId);
  if (def && (def.kind === "local" || def.kind === "powershell")) return def.id;
  return profiles.find((p) => p.kind === "local" || p.kind === "powershell")?.id;
}

/**
 * Opens a terminal for a log source in `cwd` and types `command`. With `submit: false` the
 * command is only typed, so the user can review it before pressing Enter.
 */
export function openCommandInTerminal(options: { command: string; source: string; cwd?: string | null; submit?: boolean; title?: string }) {
  const profileId = profileForSource(options.source);
  // On an SSH host the folder is remote: change into it as part of the command.
  const remote = options.source.startsWith("ssh:");
  const command = remote && options.cwd ? `cd ${shellQuote(options.cwd)} && ${options.command}` : options.command;
  const id = openTerminal({
    params: { profileId, cwd: remote ? undefined : (options.cwd ?? undefined), initialCommand: command, submitInitial: options.submit ?? false },
  });
  if (id && options.title) dockRegistry.get("panel")?.getPanel(id)?.api.setTitle(options.title);
  return id;
}

/** Opens the timeline of an agent's own log in the editor area. */
export function openAgentLog(summary: LogSummary) {
  const api = dockRegistry.get("main");
  if (!api) return null;
  const id = `agentlog-${summary.source}-${summary.nativeId}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return id;
  }
  api.addPanel({
    id,
    component: "agentLog",
    title: `${LOG_AGENT_NAMES[summary.agent]} · ${summary.title ?? summary.nativeId.slice(0, 8)}`,
    params: { source: summary.source, path: summary.path },
  });
  return id;
}

/** Opens a file in an editor tab (or focuses it if already open). */
export function openFile(path: string, options: { line?: number } = {}) {
  const api = dockRegistry.get("main");
  if (!api) return null;
  const id = editorPanelId(path);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return id;
  }
  api.addPanel({
    id,
    component: "editor",
    tabComponent: "editor",
    // Kept in the DOM while hidden: a detached editor can keep the keyboard focus (WebKit) and
    // receive typing meant for the visible file; Monaco also keeps its scroll and undo state.
    renderer: "always",
    title: baseName(path),
    params: { path, line: options.line },
  });
  return id;
}

/**
 * Local path of a file mentioned in an agent log: relative paths are resolved against the
 * conversation folder; on Windows, files of a WSL source are reached via `\\wsl.localhost\<distro>`.
 */
export function logFilePath(file: string, cwd: string | null, source: string, windows = isWindows()): string {
  const isAbsolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\");
  const full = isAbsolute || !cwd ? file : joinPath(cwd, file);
  if (windows && source.startsWith("wsl:") && full.startsWith("/")) {
    return `\\\\wsl.localhost\\${source.slice(4)}${full.replaceAll("/", "\\")}`;
  }
  return full;
}

/** Brings a running terminal to front and focuses it. */
export function revealTerminal(panelId: string, dock: DockId) {
  if (dock === "panel") useUiStore.getState().setBottomPanelVisible(true);
  const panel = dockRegistry.get(dock)?.getPanel(panelId);
  panel?.api.setActive();
  requestAnimationFrame(() => terminalRegistry.get(panelId)?.focus());
}

export function closeTerminal(panelId: string, dock: DockId) {
  dockRegistry.get(dock)?.getPanel(panelId)?.api.close();
}

export function terminalPanels(api: DockviewApi | undefined) {
  return api?.panels.filter((p) => p.view.contentComponent === "terminal") ?? [];
}

export function focusActiveTerminal(dock: DockId = "panel") {
  const panel = dockRegistry.get(dock)?.activePanel;
  if (panel) terminalRegistry.get(panel.id)?.focus();
}

export function closeActiveTerminal(dock: DockId = "panel") {
  dockRegistry.get(dock)?.activePanel?.api.close();
}

/**
 * Ctrl+`: show the bottom panel (creating a terminal if it has none) and focus it,
 * or hide it when it is already visible.
 */
export function toggleTerminalPanel() {
  const ui = useUiStore.getState();
  if (ui.bottomPanelVisible) {
    ui.setBottomPanelVisible(false);
    return;
  }
  ui.setBottomPanelVisible(true);
  if (terminalPanels(dockRegistry.get("panel")).length === 0) openTerminal();
  requestAnimationFrame(() => focusActiveTerminal());
}
