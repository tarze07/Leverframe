import { invoke } from "@tauri-apps/api/core";

export type LogAgent = "claude" | "codex" | "opencode" | "agy";

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

export const LOG_AGENT_NAMES: Record<LogAgent, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", agy: "Agy" };

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

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const RESUME: Record<LogAgent, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  opencode: (id) => `opencode --session ${id}`,
  agy: (id) => `agy --conversation ${id}`,
};

/** Command that resumes the conversation in the agent's CLI, or null if the id looks unsafe. */
export function resumeCommand(s: Pick<LogSummary, "agent" | "nativeId">): string | null {
  if (!SAFE_ID.test(s.nativeId)) return null;
  return RESUME[s.agent]?.(s.nativeId) ?? null;
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

/** A code block that its text cannot close (a longer fence than any run of backticks inside). */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** One item of the timeline as Markdown (for "Kopiuj" next to it and the whole conversation). */
export function itemMarkdown(item: TimelineItem): string {
  switch (item.kind) {
    case "user":
      return `**Ty:**\n\n${item.text}`;
    case "assistant":
      return `**Agent:**\n\n${item.text}`;
    case "thinking":
      return `**Rozumowanie:**\n\n${item.text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`;
    case "tool": {
      const { call, result } = item;
      const head = call.command
        ? `**Polecenie** (${call.name})${result?.exitCode != null ? ` – kod ${result.exitCode}` : result?.isError ? " – błąd" : ""}:\n\n${fenced(call.command, "sh")}`
        : `**Narzędzie** ${call.name}${toolLabel(call) ? `: \`${toolLabel(call).replace(/`/g, "'")}\`` : ""}${result?.isError ? " – błąd" : ""}`;
      return result?.output.trim() ? `${head}\n\nWynik:\n\n${fenced(result.output)}` : head;
    }
  }
}

/** The whole conversation as Markdown: title, folder, then the timeline (reasoning optional). */
export function conversationMarkdown(summary: LogSummary, timeline: TimelineItem[], withThinking: boolean): string {
  const meta = [LOG_AGENT_NAMES[summary.agent], summary.cwd, summary.gitBranch && `gałąź ${summary.gitBranch}`, summary.startedAt && new Date(summary.startedAt).toLocaleString("pl-PL")]
    .filter(Boolean)
    .join(" · ");
  const items = timeline.filter((i) => withThinking || i.kind !== "thinking").map(itemMarkdown);
  return [`# ${summary.title ?? summary.nativeId}`, `_${meta}_`, ...items].join("\n\n") + "\n";
}
