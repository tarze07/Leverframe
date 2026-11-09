import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FONT_MONO, DEFAULT_FONT_SIZE, useUiStore } from "./ui";

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

  it("falls back to defaults for invalid font settings and clamps size", () => {
    const s = useUiStore.getState();
    s.setFontMono("   ");
    s.setFontSize(Number.NaN);
    expect(useUiStore.getState()).toMatchObject({ fontMono: DEFAULT_FONT_MONO, fontSize: DEFAULT_FONT_SIZE });
    s.setFontSize(100);
    expect(useUiStore.getState().fontSize).toBe(32);
  });
});
