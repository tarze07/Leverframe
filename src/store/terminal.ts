import { create } from "zustand";

interface TerminalState {
  /** Program of the most recently focused terminal (shown in the status bar). */
  activeProgram: string | null;
  setActiveProgram: (program: string | null) => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  activeProgram: null,
  setActiveProgram: (activeProgram) => set({ activeProgram }),
}));
