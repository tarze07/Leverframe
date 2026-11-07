import { invoke } from "@tauri-apps/api/core";

export type LogAgent = "claude" | "codex";

export interface LogSummary {
  agent: LogAgent;
  nativeId: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  updatedAt: number;
  path: string;
  source: string;
  size: number;
}

export type LogEntry =
  | { kind: "user"; text: string; ts: number | null }
  | { kind: "assistant"; text: string; ts: number | null }
  | { kind: "thinking"; text: string; ts: number | null }
  | { kind: "toolCall"; id: string; name: string; input: unknown; command: string | null; files: string[]; ts: number | null }
  | { kind: "toolResult"; callId: string; output: string; isError: boolean; exitCode: number | null; ts: number | null };

export interface LogDetail {
  summary: LogSummary;
  entries: LogEntry[];
  skippedLines: number;
}

export const agentLogsClient = {
  list: (source: string) => invoke<LogSummary[]>("agent_logs_list", { source }),
  read: (source: string, path: string) => invoke<LogDetail>("agent_log_read", { source, path }),
};

export const LOG_AGENT_NAMES: Record<LogAgent, string> = { claude: "Claude Code", codex: "Codex" };

export type ToolCall = Extract<LogEntry, { kind: "toolCall" }>;
export type ToolResult = Extract<LogEntry, { kind: "toolResult" }>;

export type TimelineItem =
  | { kind: "user"; text: string; ts: number | null }
  | { kind: "assistant"; text: string; ts: number | null }
  | { kind: "thinking"; text: string; ts: number | null }
  | { kind: "tool"; call: ToolCall; result: ToolResult | null; ts: number | null };

/** Pairs every tool call with its result (by id); results without a call are dropped. */
export function buildTimeline(entries: LogEntry[]): TimelineItem[] {
  const results = new Map<string, ToolResult>();
  for (const e of entries) if (e.kind === "toolResult" && e.callId) results.set(e.callId, e);
  const items: TimelineItem[] = [];
  for (const e of entries) {
    if (e.kind === "toolCall") items.push({ kind: "tool", call: e, result: results.get(e.id) ?? null, ts: e.ts });
    else if (e.kind !== "toolResult") items.push(e);
  }
  return items;
}

/** Files written by the agent, in first-touch order. */
export function changedFiles(entries: LogEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of entries) if (e.kind === "toolCall") e.files.forEach((f) => seen.add(f));
  return [...seen];
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** Command that resumes the conversation in the agent's CLI, or null if the id looks unsafe. */
export function resumeCommand(s: Pick<LogSummary, "agent" | "nativeId">): string | null {
  if (!SAFE_ID.test(s.nativeId)) return null;
  return s.agent === "claude" ? `claude --resume ${s.nativeId}` : `codex resume ${s.nativeId}`;
}

/** Short label for a tool call when it is not a shell command. */
export function toolLabel(call: ToolCall): string {
  if (call.command) return call.command;
  if (call.files.length) return call.files.join(", ");
  const input = call.input as Record<string, unknown> | null;
  for (const key of ["file_path", "path", "pattern", "query", "url", "description"]) {
    const v = input && typeof input === "object" ? input[key] : undefined;
    if (typeof v === "string") return v;
  }
  return "";
}
