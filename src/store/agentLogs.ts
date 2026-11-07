import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/tauri";
import { agentLogsClient, type LogSummary } from "../features/sessions/agentLogsClient";

interface AgentLogsStore {
  /** `local` or `wsl:<distro>`. */
  source: string;
  logs: LogSummary[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  setSource: (source: string) => void;
  refresh: () => Promise<void>;
  /** Re-lists when the local log directories change (file watcher in the backend). */
  watch: () => () => void;
}

let seq = 0;

export const useAgentLogsStore = create<AgentLogsStore>()((set, get) => ({
  source: "local",
  logs: [],
  status: "idle",
  error: null,
  setSource: (source) => {
    set({ source, logs: [] });
    void get().refresh();
  },
  refresh: async () => {
    if (!isTauri()) {
      set({ status: "ready" });
      return;
    }
    const mine = ++seq;
    const { source } = get();
    set({ status: "loading", error: null });
    try {
      const logs = await agentLogsClient.list(source);
      if (mine === seq) set({ logs, status: "ready" });
    } catch (e) {
      if (mine === seq) set({ status: "error", error: String(e), logs: [] });
    }
  },
  watch: () => {
    if (!isTauri()) return () => undefined;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen("agent-logs-changed", () => {
      if (get().source === "local") void get().refresh();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  },
}));
