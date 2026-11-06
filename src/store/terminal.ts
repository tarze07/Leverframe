import { create } from "zustand";

export interface RunningTerminal {
  panelId: string;
  dock: "main" | "panel";
  title: string;
  profileId: string | null;
  agentId?: string | null;
  /** Process finished but the tab is still open (non-zero exit). */
  exited: boolean;
}

interface TerminalState {
  running: RunningTerminal[];
  /** Panel id of the most recently focused terminal. */
  activePanelId: string | null;
  upsert: (t: RunningTerminal) => void;
  update: (panelId: string, patch: Partial<RunningTerminal>) => void;
  remove: (panelId: string) => void;
  setActive: (panelId: string | null) => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  running: [],
  activePanelId: null,
  upsert: (t) =>
    set((s) => ({
      running: s.running.some((r) => r.panelId === t.panelId)
        ? s.running.map((r) => (r.panelId === t.panelId ? t : r))
        : [...s.running, t],
    })),
  update: (panelId, patch) =>
    set((s) => ({ running: s.running.map((r) => (r.panelId === panelId ? { ...r, ...patch } : r)) })),
  remove: (panelId) =>
    set((s) => ({
      running: s.running.filter((r) => r.panelId !== panelId),
      activePanelId: s.activePanelId === panelId ? null : s.activePanelId,
    })),
  setActive: (activePanelId) => set({ activePanelId }),
}));

/** The terminal shown in the status bar. */
export const selectActiveTerminal = (s: TerminalState): RunningTerminal | undefined =>
  s.running.find((r) => r.panelId === s.activePanelId);
