import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../lib/storage";

export type ViewId = "terminals" | "agents" | "sessions" | "files" | "settings";

export const DEFAULT_FONT_MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace';
export const DEFAULT_FONT_SIZE = 13;

export interface UiState {
  activeView: ViewId;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  fontMono: string;
  fontSize: number;
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
      setQuickOpen: (quickOpen) => set({ quickOpen }),
      selectView: (view) => {
        const { activeView, sidebarVisible } = get();
        if (view === activeView) set({ sidebarVisible: !sidebarVisible });
        else set({ activeView: view, sidebarVisible: true });
      },
      setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
      toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
      setBottomPanelVisible: (bottomPanelVisible) => set({ bottomPanelVisible }),
      toggleBottomPanel: () => set({ bottomPanelVisible: !get().bottomPanelVisible }),
      setFontMono: (fontMono) => set({ fontMono: fontMono.trim() || DEFAULT_FONT_MONO }),
      setFontSize: (fontSize) =>
        set({ fontSize: Number.isFinite(fontSize) ? Math.min(32, Math.max(8, Math.round(fontSize))) : DEFAULT_FONT_SIZE }),
    }),
    {
      name: "leverframe.ui",
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ activeView, sidebarVisible, bottomPanelVisible, fontMono, fontSize }) => ({
        activeView,
        sidebarVisible,
        bottomPanelVisible,
        fontMono,
        fontSize,
      }),
    },
  ),
);
