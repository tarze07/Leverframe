import { describe, expect, it } from "vitest";
import { buildTimeline, changedFiles, resumeCommand, toolLabel, type LogEntry } from "./agentLogsClient";

const entries: LogEntry[] = [
  { kind: "user", text: "Fix tests", ts: 1 },
  { kind: "toolCall", id: "t1", name: "Bash", input: { command: "npm test" }, command: "npm test", files: [], ts: 2 },
  { kind: "toolCall", id: "t2", name: "Edit", input: { file_path: "/a.ts" }, command: null, files: ["/a.ts"], ts: 3 },
  { kind: "toolResult", callId: "t1", output: "Exit code 1", isError: true, exitCode: 1, ts: 4 },
  { kind: "toolResult", callId: "orphan", output: "?", isError: false, exitCode: null, ts: 5 },
  { kind: "toolCall", id: "t3", name: "Write", input: { file_path: "/a.ts" }, command: null, files: ["/a.ts", "/b.ts"], ts: 6 },
  { kind: "assistant", text: "Done", ts: 7 },
];

describe("agent log helpers", () => {
  it("pairs tool calls with results and keeps order", () => {
    const t = buildTimeline(entries);
    expect(t.map((i) => i.kind)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
    const first = t[1];
    expect(first.kind === "tool" && first.result?.exitCode).toBe(1);
    const edit = t[2];
    expect(edit.kind === "tool" && edit.result).toBeNull();
  });

  it("lists changed files once", () => {
    expect(changedFiles(entries)).toEqual(["/a.ts", "/b.ts"]);
  });

  it("builds resume commands only for safe ids", () => {
    expect(resumeCommand({ agent: "claude", nativeId: "5f1c2a9e-1111" })).toBe("claude --resume 5f1c2a9e-1111");
    expect(resumeCommand({ agent: "codex", nativeId: "0199a1b2" })).toBe("codex resume 0199a1b2");
    expect(resumeCommand({ agent: "claude", nativeId: "x; rm -rf ~" })).toBeNull();
  });

  it("labels tool calls", () => {
    expect(toolLabel(entries[1] as never)).toBe("npm test");
    expect(toolLabel(entries[2] as never)).toBe("/a.ts");
    expect(toolLabel({ kind: "toolCall", id: "x", name: "Grep", input: { pattern: "TODO" }, command: null, files: [], ts: null })).toBe("TODO");
  });
});
