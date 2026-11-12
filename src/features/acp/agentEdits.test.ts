import { describe, expect, it } from "vitest";
import { AgentEdits } from "./agentEdits";

describe("AgentEdits", () => {
  it("returns the files of an edit once it completes, from partial updates", () => {
    const edits = new AgentEdits();
    expect(edits.feed({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "pending", locations: [{ path: "/p/a.ts" }] })).toEqual([]);
    expect(
      edits.feed({ sessionUpdate: "tool_call_update", toolCallId: "e", content: [{ type: "diff", path: "/p/b.ts", oldText: "x", newText: "y" }] }),
    ).toEqual([]);
    expect(edits.feed({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" })).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(edits.feed({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" })).toEqual([]); // only once
  });

  it("ignores reads, commands, failures and other updates", () => {
    const edits = new AgentEdits();
    expect(edits.feed({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read", kind: "read", status: "completed", locations: [{ path: "/p/a.ts" }] })).toEqual([]);
    expect(edits.feed({ sessionUpdate: "tool_call", toolCallId: "x", title: "ls", kind: "execute", status: "completed" })).toEqual([]);
    expect(edits.feed({ sessionUpdate: "tool_call", toolCallId: "f", title: "Edit", kind: "edit", status: "failed", locations: [{ path: "/p/a.ts" }] })).toEqual([]);
    expect(edits.feed({ sessionUpdate: "plan", entries: [] })).toEqual([]);
    expect(edits.feed({ sessionUpdate: "tool_call", toolCallId: "d", title: "Usuń", kind: "delete", status: "completed", locations: [{ path: "/p/old.ts" }] })).toEqual(["/p/old.ts"]);
  });
});
