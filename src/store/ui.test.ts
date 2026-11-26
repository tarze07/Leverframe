import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FONT_MONO, DEFAULT_FONT_SIZE, useUiStore, isSidePosition, panelFirst, swappedPosition, turnedPosition } from "./ui";

const initial = useUiStore.getState();

describe("ui store", () => {
  beforeEach(() => useUiStore.setState(initial, true));

  it("switches view and shows the sidebar", () => {
    useUiStore.setState({ sidebarVisible: false });
    useUiStore.getState().selectView("agents");
    expect(useUiStore.getState()).toMatchObject({ activeView: "agents", sidebarVisible: true });
  });

  it("toggles the sidebar when the active view is clicked again", () => {
    useUiStore.getState().selectView("terminals");
    expect(useUiStore.getState().sidebarVisible).toBe(false);
    useUiStore.getState().selectView("terminals");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("toggles the bottom panel", () => {
    useUiStore.getState().toggleBottomPanel();
    expect(useUiStore.getState().bottomPanelVisible).toBe(false);
  });

  it("maximizes the terminal panel and restores the editor", () => {
    const s = useUiStore.getState();
    useUiStore.setState({ bottomPanelVisible: false });
    s.togglePanelMaximized();
    expect(useUiStore.getState()).toMatchObject({ maximized: "panel", bottomPanelVisible: true });
    s.togglePanelMaximized();
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: true });
  });

  it("maximizes the editor by hiding the panel, and brings the panel back", () => {
    const s = useUiStore.getState();
    s.toggleEditorMaximized();
    expect(useUiStore.getState()).toMatchObject({ maximized: "editor", bottomPanelVisible: false });
    s.toggleEditorMaximized();
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: true });
  });

  it("ends a maximized state when the panel is shown or hidden", () => {
    const s = useUiStore.getState();
    s.togglePanelMaximized();
    s.setBottomPanelVisible(false); // e.g. last terminal closed: the editor must come back
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: false });
    s.toggleEditorMaximized();
    s.toggleBottomPanel();
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: true });
  });

  it("shows the terminal panel for a new terminal without changing the layout", () => {
    const s = useUiStore.getState();
    s.setPanelPosition("right");
    s.togglePanelMaximized();
    s.showBottomPanel(); // a new terminal while the panel is maximized: it stays so
    expect(useUiStore.getState()).toMatchObject({ maximized: "panel", bottomPanelVisible: true, panelPosition: "right" });
    s.togglePanelMaximized();
    s.showBottomPanel();
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: true });
    // A hidden panel (editor maximized) has to come back for the terminal.
    s.toggleEditorMaximized();
    s.showBottomPanel();
    expect(useUiStore.getState()).toMatchObject({ maximized: null, bottomPanelVisible: true, panelPosition: "right" });
    s.setPanelPosition("bottom");
  });

  it("falls back to defaults for invalid font settings and clamps size", () => {
    const s = useUiStore.getState();
    s.setFontMono("   ");
    s.setFontSize(Number.NaN);
    expect(useUiStore.getState()).toMatchObject({ fontMono: DEFAULT_FONT_MONO, fontSize: DEFAULT_FONT_SIZE });
    s.setFontSize(100);
    expect(useUiStore.getState().fontSize).toBe(32);
  });
});

describe("terminal panel positions (#124)", () => {
  it("swaps the panel with the editor and turns it beside or below on the same side", () => {
    expect(swappedPosition("bottom")).toBe("top");
    expect(swappedPosition("top")).toBe("bottom");
    expect(swappedPosition("right")).toBe("left");
    expect(swappedPosition("left")).toBe("right");
    expect(turnedPosition("bottom")).toBe("right");
    expect(turnedPosition("top")).toBe("left");
    expect(turnedPosition("left")).toBe("top");
    expect(isSidePosition("left") && isSidePosition("right") && !isSidePosition("top")).toBe(true);
    expect(panelFirst("top") && panelFirst("left") && !panelFirst("bottom") && !panelFirst("right")).toBe(true);

    useUiStore.setState({ panelPosition: "bottom" });
    useUiStore.getState().swapPanel();
    expect(useUiStore.getState().panelPosition).toBe("top");
    useUiStore.getState().setPanelPosition("right");
    useUiStore.getState().swapPanel();
    expect(useUiStore.getState().panelPosition).toBe("left");
  });
});
