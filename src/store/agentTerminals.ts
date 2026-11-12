import { create } from "zustand";

/** Output kept per command for the UI (the agent has its own, limited copy in the backend). */
export const MAX_TERMINAL_DATA = 2 * 1024 * 1024;

export interface AgentTerminalState {
  command: string;
  cwd: string | null;
  /** Terminal output as received (escape sequences included, for xterm). */
  data: string;
  /** Characters dropped from the beginning to stay within MAX_TERMINAL_DATA. */
  dropped: number;
  exit: { code: number | null; signal: string | null } | null;
}

interface AgentTerminalsStore {
  /** By `${chat panel id}/${terminal id}`. */
  terminals: Record<string, AgentTerminalState>;
  start: (key: string, command: string, cwd: string | null) => void;
  append: (key: string, chunk: string) => void;
  exit: (key: string, code: number | null, signal: string | null) => void;
  /** Forgets the commands of a conversation (its panel closed). */
  forget: (prefix: string) => void;
}

export const agentTerminalKey = (chatId: string, terminalId: string) => `${chatId}/${terminalId}`;

export const useAgentTerminalsStore = create<AgentTerminalsStore>()((set) => ({
  terminals: {},
  start: (key, command, cwd) =>
    set((s) => ({ terminals: { ...s.terminals, [key]: { command, cwd, data: "", dropped: 0, exit: null } } })),
  append: (key, chunk) =>
    set((s) => {
      const t = s.terminals[key];
      if (!t) return s;
      let data = t.data + chunk;
      let dropped = t.dropped;
      if (data.length > MAX_TERMINAL_DATA) {
        const cut = data.length - MAX_TERMINAL_DATA;
        data = data.slice(cut);
        dropped += cut;
      }
      return { terminals: { ...s.terminals, [key]: { ...t, data, dropped } } };
    }),
  exit: (key, code, signal) =>
    set((s) => (s.terminals[key] ? { terminals: { ...s.terminals, [key]: { ...s.terminals[key], exit: { code, signal } } } } : s)),
  forget: (prefix) =>
    set((s) => ({ terminals: Object.fromEntries(Object.entries(s.terminals).filter(([k]) => !k.startsWith(`${prefix}/`))) })),
}));
