import { create } from "zustand";
import { isTauri } from "../lib/tauri";
import {
  rangeStart,
  sessionsClient,
  type DateRange,
  type Facets,
  type SessionKind,
  type SessionRecord,
} from "../features/sessions/sessionsClient";

export interface SessionFilters {
  query: string;
  /** "" = recordings and conversations. */
  kind: "" | SessionKind;
  agentId: string;
  profileId: string;
  cwd: string;
  range: DateRange;
}

const EMPTY_FILTERS: SessionFilters = { query: "", kind: "", agentId: "", profileId: "", cwd: "", range: "all" };

interface SessionsStore {
  filters: SessionFilters;
  sessions: SessionRecord[];
  facets: Facets;
  recordingEnabled: boolean;
  recordingsDir: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  setFilters: (patch: Partial<SessionFilters>) => void;
  resetFilters: () => void;
  refresh: () => Promise<void>;
  loadInfo: () => Promise<void>;
  setRecording: (enabled: boolean) => Promise<void>;
  remove: (id: number) => Promise<void>;
  clear: () => Promise<number>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
let requestSeq = 0;

export const useSessionsStore = create<SessionsStore>()((set, get) => ({
  filters: EMPTY_FILTERS,
  sessions: [],
  facets: { agents: [], profiles: [], cwds: [] },
  recordingEnabled: true,
  recordingsDir: null,
  status: "idle",
  error: null,
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: EMPTY_FILTERS }),
  refresh: async () => {
    if (!isTauri()) {
      set({ status: "ready" });
      return;
    }
    const seq = ++requestSeq;
    const f = get().filters;
    set({ status: "loading", error: null });
    try {
      const [sessions, facets] = await Promise.all([
        sessionsClient.list({
          query: f.query.trim() || undefined,
          kind: f.kind || undefined,
          agentId: f.agentId || undefined,
          profileId: f.profileId || undefined,
          cwd: f.cwd || undefined,
          from: rangeStart(f.range),
        }),
        sessionsClient.facets(),
      ]);
      if (seq === requestSeq) set({ sessions, facets, status: "ready" }); // ignore stale responses
    } catch (e) {
      if (seq === requestSeq) set({ status: "error", error: message(e) });
    }
  },
  loadInfo: async () => {
    if (!isTauri()) return;
    try {
      const info = await sessionsClient.info();
      set({ recordingEnabled: info.recordingEnabled, recordingsDir: info.recordingsDir });
    } catch (e) {
      set({ error: message(e) });
    }
  },
  setRecording: async (enabled) => {
    await sessionsClient.setRecording(enabled);
    set({ recordingEnabled: enabled });
  },
  remove: async (id) => {
    await sessionsClient.remove(id);
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
    void get().refresh();
  },
  clear: async () => {
    const removed = await sessionsClient.clear();
    await get().refresh();
    return removed;
  },
}));
