import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { useUiStore } from "../store/ui";
import { dockRegistry } from "./docks";
import { logFilePath, openTerminal, terminalPanels, toggleTerminalPanel } from "./commands";

interface FakePanel {
  id: string;
  view: { contentComponent: string };
}

function fakeDock() {
  const panels: FakePanel[] = [];
  const addPanel = vi.fn((opts: { id: string; component: string }) => {
    const panel = { id: opts.id, view: { contentComponent: opts.component } };
    panels.push(panel);
    return panel;
  });
  const api = {
    panels,
    addPanel,
    get activePanel() {
      return panels[panels.length - 1];
    },
  };
  return api as unknown as DockviewApi & { addPanel: typeof addPanel };
}

describe("workbench commands", () => {
  const initial = useUiStore.getState();
  beforeEach(() => {
    useUiStore.setState(initial, true);
    dockRegistry.set("panel", null);
    dockRegistry.set("main", null);
  });

  it("opens a terminal in the bottom panel and shows it", () => {
    const dock = fakeDock();
    dockRegistry.set("panel", dock);
    useUiStore.setState({ bottomPanelVisible: false });

    const id = openTerminal();
    expect(id).toMatch(/^terminal-/);
    expect(useUiStore.getState().bottomPanelVisible).toBe(true);
    expect(dock.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ component: "terminal", renderer: "always", position: undefined }),
    );
  });

  it("splits next to the active terminal", () => {
    const dock = fakeDock();
    dockRegistry.set("main", dock);
    const first = openTerminal({ dock: "main" });
    openTerminal({ dock: "main", split: "right" });
    expect(dock.addPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { referencePanel: first, direction: "right" } }),
    );
    expect(terminalPanels(dock)).toHaveLength(2);
  });

  it("returns null when the dock is not ready", () => {
    expect(openTerminal()).toBeNull();
  });

  it("Ctrl+` creates a terminal when showing an empty panel and hides a visible one", () => {
    const dock = fakeDock();
    dockRegistry.set("panel", dock);
    useUiStore.setState({ bottomPanelVisible: false });

    toggleTerminalPanel();
    expect(useUiStore.getState().bottomPanelVisible).toBe(true);
    expect(terminalPanels(dock)).toHaveLength(1);

    toggleTerminalPanel();
    expect(useUiStore.getState().bottomPanelVisible).toBe(false);

    toggleTerminalPanel(); // already has a terminal: no new one
    expect(terminalPanels(dock)).toHaveLength(1);
  });
});

describe("logFilePath", () => {
  it("resolves relative paths against the conversation folder", () => {
    expect(logFilePath("src/a.ts", "/home/me/app", "local", false)).toBe("/home/me/app/src/a.ts");
    expect(logFilePath("/abs/b.ts", "/home/me/app", "local", false)).toBe("/abs/b.ts");
    expect(logFilePath("src/a.ts", "C:\\work\\app", "local", true)).toBe("C:\\work\\app\\src\\a.ts");
  });

  it("maps WSL files to \\\\wsl.localhost on Windows", () => {
    expect(logFilePath("/home/me/app/a.ts", null, "wsl:Ubuntu", true)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\a.ts");
    expect(logFilePath("src/a.ts", "/home/me/app", "wsl:Ubuntu", true)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\src\\a.ts");
    expect(logFilePath("/home/me/a.ts", null, "wsl:Ubuntu", false)).toBe("/home/me/a.ts");
  });
});
