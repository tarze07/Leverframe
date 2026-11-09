import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../lib/storage";

export type ViewId = "terminals" | "agents" | "sessions" | "files" | "settings";

export const DEFAULT_FONT_MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace';
export const DEFAULT_FONT_SIZE = 13;

/** Where the terminal panel sits relative to the editor area. */
export type PanelPosition = "bottom" | "right";
/** Area that fills the center: "panel" hides the editor, "editor" hides the terminal panel. */
export type Maximized = "panel" | "editor" | null;

export interface UiState {
  activeView: ViewId;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  fontMono: string;
  fontSize: number;
  /** Theme from settings.json: a theme id or "system" (then `darkTheme` / `lightTheme` by the OS). */
  theme: string;
  darkTheme: string;
  lightTheme: string;
  /** Theme in effect and its kind. */
  resolvedThemeId: string;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: string) => void;
  setThemePreferences: (prefs: { darkTheme?: string; lightTheme?: string }) => void;
  setResolvedTheme: (kind: "dark" | "light", id: string) => void;
  panelPosition: PanelPosition;
  setPanelPosition: (position: PanelPosition) => void;
  maximized: Maximized;
  /** Terminal panel over the whole center (editor hidden), or back. */
  togglePanelMaximized: () => void;
  /** Editor over the whole center (terminal panel hidden), or back. */
  toggleEditorMaximized: () => void;
  setMaximized: (maximized: Maximized) => void;
  /** Command palette (Ctrl+Shift+P) visible – not persisted. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Quick open (Ctrl+P) dialog visible – not persisted. */
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  /** Activity bar click: switch view, or toggle the sidebar when the view is already active (VS Code behaviour). */
  selectView: (view: ViewId) => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  setBottomPanelVisible: (visible: boolean) => void;
  toggleBottomPanel: () => void;
  setFontMono: (font: string) => void;
  setFontSize: (size: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      activeView: "terminals",
      sidebarVisible: true,
      bottomPanelVisible: true,
      fontMono: DEFAULT_FONT_MONO,
      fontSize: DEFAULT_FONT_SIZE,
      quickOpen: false,
      theme: "dark",
      darkTheme: "dark",
      lightTheme: "light",
      resolvedThemeId: "dark",
      resolvedTheme: "dark",
      setTheme: (theme) => set({ theme }),
      setThemePreferences: (prefs) => set(prefs),
      setResolvedTheme: (resolvedTheme, resolvedThemeId) => set({ resolvedTheme, resolvedThemeId }),
      panelPosition: "bottom",
      setPanelPosition: (panelPosition) => set({ panelPosition }),
      maximized: null,
      togglePanelMaximized: () =>
        set(get().maximized === "panel" ? { maximized: null } : { maximized: "panel", bottomPanelVisible: true }),
      toggleEditorMaximized: () =>
        set(
          get().maximized === "editor"
            ? { maximized: null, bottomPanelVisible: true }
            : { maximized: "editor", bottomPanelVisible: false },
        ),
      setMaximized: (maximized) => set({ maximized }),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setQuickOpen: (quickOpen) => set({ quickOpen }),
      selectView: (view) => {
        const { activeView, sidebarVisible } = get();
        if (view === activeView) set({ sidebarVisible: !sidebarVisible });
        else set({ activeView: view, sidebarVisible: true });
      },
      setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
      toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
      // Showing or hiding the panel ends a maximized state (the editor comes back with it).
      setBottomPanelVisible: (bottomPanelVisible) => set({ bottomPanelVisible, maximized: null }),
      toggleBottomPanel: () => get().setBottomPanelVisible(!get().bottomPanelVisible),
      setFontMono: (fontMono) => set({ fontMono: fontMono.trim() || DEFAULT_FONT_MONO }),
      setFontSize: (fontSize) =>
        set({ fontSize: Number.isFinite(fontSize) ? Math.min(32, Math.max(8, Math.round(fontSize))) : DEFAULT_FONT_SIZE }),
    }),
    {
      name: "leverframe.ui",
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ activeView, sidebarVisible, bottomPanelVisible, fontMono, fontSize, panelPosition, maximized }) => ({
        activeView,
        sidebarVisible,
        bottomPanelVisible,
        fontMono,
        fontSize,
        panelPosition,
        maximized,
      }),
    },
  ),
);
