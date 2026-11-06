import type { DockviewApi } from "dockview-react";
import { useUiStore } from "../store/ui";
import { useProfilesStore } from "../store/profiles";
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
