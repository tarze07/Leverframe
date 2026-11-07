import { invoke } from "@tauri-apps/api/core";

export interface SessionRecord {
  id: number;
  agentId: string | null;
  agentName: string | null;
  profileId: string | null;
  profileName: string | null;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  castPath: string;
  bytes: number;
  snippet: string | null;
}

export interface SessionFilter {
  agentId?: string;
  profileId?: string;
  cwd?: string;
  from?: number;
  to?: number;
  query?: string;
  limit?: number;
}

export interface Facets {
  agents: { id: string; name: string }[];
  profiles: { id: string; name: string }[];
  cwds: string[];
}

export interface SessionsInfo {
  recordingEnabled: boolean;
  recordingsDir: string;
}

export const sessionsClient = {
  info: () => invoke<SessionsInfo>("sessions_info"),
  list: (filter: SessionFilter) => invoke<SessionRecord[]>("sessions_list", { filter }),
  facets: () => invoke<Facets>("sessions_facets"),
  read: (id: number) => invoke<string>("sessions_read", { id }),
  remove: (id: number) => invoke<void>("sessions_delete", { id }),
  clear: () => invoke<number>("sessions_clear"),
  setRecording: (enabled: boolean) => invoke<void>("sessions_set_recording", { enabled }),
};

export type DateRange = "all" | "today" | "7d" | "30d";

/** Start of the range in ms (local time), or undefined for "all". */
export function rangeStart(range: DateRange, now = new Date()): number | undefined {
  if (range === "all") return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start.getTime();
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

/** Splits a search snippet with `[[match]]` markers into parts for highlighting. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  const re = /\[\[(.*?)\]\]/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    parts.push({ text: m[1], match: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}
