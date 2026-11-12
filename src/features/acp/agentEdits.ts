import type { SessionUpdate, ToolContent, ToolKind, ToolLocation } from "./acpClient";

const CHANGES_FILES: ToolKind[] = ["edit", "delete", "move"];

/**
 * Files an agent changed with its own tools (e.g. Claude's Edit), which do not go through
 * Leverframe: when such a tool call completes, its files (locations and diffs) are returned so
 * the panel can refresh open editors and the file tree. Updates may be partial, so what is
 * known about each call is kept.
 */
export class AgentEdits {
  private tools = new Map<string, { kind?: ToolKind | null; paths: Set<string>; done: boolean }>();

  /** Paths to refresh after this update (empty when nothing finished). */
  feed(update: SessionUpdate): string[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return [];
    const u = update as { toolCallId: string; kind?: ToolKind | null; status?: string | null; locations?: ToolLocation[] | null; content?: ToolContent[] | null };
    const tool = this.tools.get(u.toolCallId) ?? { paths: new Set<string>(), done: false };
    this.tools.set(u.toolCallId, tool);
    if (u.kind) tool.kind = u.kind;
    for (const l of u.locations ?? []) if (l.path) tool.paths.add(l.path);
    for (const c of u.content ?? []) if (c.type === "diff" && c.path) tool.paths.add(c.path);
    if (u.status !== "completed" || tool.done || !tool.kind || !CHANGES_FILES.includes(tool.kind)) return [];
    tool.done = true;
    return [...tool.paths];
  }
}
