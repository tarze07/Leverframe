import { describe, expect, it } from "vitest";
import type { AcpEvent, SessionUpdate } from "./acpClient";
import { blockText, chatReducer, initialChat, matchingCommands, type ChatAction, type ChatState } from "./chatState";

const ev = (event: AcpEvent): ChatAction => ({ type: "event", event });
const up = (update: SessionUpdate): ChatAction => ev({ type: "update", update });
const run = (actions: ChatAction[], from: ChatState = initialChat) => actions.reduce(chatReducer, from);
const chunk = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk", text: string) =>
  up({ sessionUpdate, content: { type: "text", text } });
const ready = ev({
  type: "sessionReady",
  sessionId: "s1",
  cwd: "/home/me/app",
  modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Kod" }, { id: "ask", name: "Pytania" }] },
  configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Szybki" }] }],
});

describe("chat state", () => {
  it("joins streamed chunks into messages, in order with tool calls", () => {
    const s = run([
      ev({ type: "initialized", agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.68.0" }, agentCapabilities: {}, authMethods: [] }),
      ready,
      { type: "sent", text: "Popraw testy" },
      chunk("agent_thought_chunk", "Najpierw "),
      chunk("agent_thought_chunk", "przeczytam"),
      chunk("agent_message_chunk", "Czytam "),
      up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Czytam README", kind: "read", status: "in_progress" }),
      chunk("agent_message_chunk", "Gotowe, "),
      chunk("agent_message_chunk", "**3** testy."),
      { type: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(s).toMatchObject({ status: "ready", agentName: "Gemini CLI", agentVersion: "0.68.0", cwd: "/home/me/app" });
    expect(s.items).toEqual([
      { kind: "message", role: "user", text: "Popraw testy" },
      { kind: "message", role: "thought", text: "Najpierw przeczytam" },
      { kind: "message", role: "agent", text: "Czytam " },
      { kind: "tool", id: "t1" },
      { kind: "message", role: "agent", text: "Gotowe, **3** testy." },
    ]);
  });

  it("updates tool cards by toolCallId and keeps unchanged fields", () => {
    const s = run([
      up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "pending", locations: [{ path: "/a/b.ts", line: 3 }] }),
      up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
      up({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "1 failed" } }],
      }),
      // An update without the initial tool_call still shows up.
      up({ sessionUpdate: "tool_call_update", toolCallId: "t2", title: "Szukam", status: "completed" }),
    ]);
    expect(s.items).toEqual([
      { kind: "tool", id: "t1" },
      { kind: "tool", id: "t2" },
    ]);
    expect(s.tools.t1).toEqual({
      id: "t1",
      title: "npm test",
      kind: "execute",
      status: "failed",
      locations: [{ path: "/a/b.ts", line: 3 }],
      content: [{ type: "content", content: { type: "text", text: "1 failed" } }],
    });
    expect(s.tools.t2).toMatchObject({ title: "Szukam", kind: "other", status: "completed" });
  });

  it("replaces the plan of a turn in place, and starts a new one in the next turn", () => {
    const entries = (status: "pending" | "completed") => [{ content: "Testy", priority: "high" as const, status }];
    let s = run([ready, { type: "sent", text: "a" }, up({ sessionUpdate: "plan", entries: entries("pending") }), chunk("agent_message_chunk", "ok")]);
    s = run([up({ sessionUpdate: "plan", entries: entries("completed") })], s);
    expect(s.items.filter((i) => i.kind === "plan")).toEqual([{ kind: "plan", entries: entries("completed") }]);
    expect(s.items[1]).toEqual({ kind: "plan", entries: entries("completed") }); // where it first appeared
    s = run([{ type: "turnEnded", stopReason: "end_turn" }, { type: "sent", text: "b" }, up({ sessionUpdate: "plan", entries: entries("pending") })], s);
    expect(s.items.filter((i) => i.kind === "plan")).toHaveLength(2);
  });

  it("adds a notice when a turn ends unusually", () => {
    const s = run([ready, { type: "sent", text: "x" }]);
    expect(s.status).toBe("busy");
    expect(chatReducer(s, { type: "turnEnded", stopReason: "cancelled" }).items.at(-1)).toEqual({ kind: "notice", text: "Przerwano." });
    expect(chatReducer(s, { type: "turnEnded", stopReason: "max_tokens" }).items.at(-1)).toMatchObject({ text: /limit długości/ });
    expect(chatReducer(s, { type: "turnEnded", stopReason: "end_turn" }).items).toEqual(s.items);
  });

  it("keeps commands, modes, options, usage and the session title", () => {
    let s = run([
      ready,
      up({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Przejrzyj" }] }),
      up({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.4, currency: "USD" } }),
      up({ sessionUpdate: "session_info_update", title: "Naprawa testów" }),
      up({ sessionUpdate: "current_mode_update", currentModeId: "ask" }),
      up({ sessionUpdate: "something_new_in_v1_2", foo: 1 }),
    ]);
    expect(s.commands[0].name).toBe("review");
    expect(s.usage).toEqual({ used: 1200, size: 200000, cost: { amount: 0.4, currency: "USD" } });
    expect(s.title).toBe("Naprawa testów");
    expect(s.modes?.currentModeId).toBe("ask");
    s = run([{ type: "modeChosen", modeId: "code" }, { type: "optionChosen", configId: "model", value: "smart" }], s);
    expect(s.modes?.currentModeId).toBe("code");
    expect(s.configOptions[0]).toMatchObject({ currentValue: "smart" });
    s = run([up({ sessionUpdate: "config_option_update", configOptions: [] })], s);
    expect(s.configOptions).toEqual([]);
  });

  it("tracks permission requests until they are closed", () => {
    const s = run([
      ev({ type: "permission", requestId: 1, toolCall: { title: "Uruchom npm test" }, options: [{ optionId: "a", name: "Zezwól", kind: "allow_once" }] }),
      ev({ type: "permission", requestId: 2, toolCall: {}, options: [] }),
      ev({ type: "permissionClosed", requestId: 1 }),
    ]);
    expect(s.permissions).toEqual([{ requestId: 2, title: "Agent prosi o zgodę", toolCall: {}, options: [] }]);
  });

  it("asks for login, and recognises a missing agent program", () => {
    const methods = [{ id: "oauth", name: "Zaloguj przez Google" }];
    const s = run([
      ev({ type: "initialized", agentInfo: null, agentCapabilities: {}, authMethods: methods }),
      ev({ type: "authRequired", authMethods: [], message: "Najpierw się zaloguj" }),
    ]);
    expect(s).toMatchObject({ status: "auth", authMethods: methods, authMessage: "Najpierw się zaloguj" });

    // sh: "exec: claude-agent-acp: not found" → 127; cmd.exe → 9009.
    const missing = run([ev({ type: "log", line: "exec: claude-agent-acp: not found" }), ev({ type: "exited", code: 127, message: "not found" })]);
    expect(missing).toMatchObject({ status: "exited", missingProgram: true });
    const crashed = run([ready, ev({ type: "exited", code: 127, message: "x" })]);
    expect(crashed.missingProgram).toBe(false); // the session ran: not a missing program
  });

  it("reports errors and keeps the last log lines", () => {
    let s = run([ev({ type: "log", line: "fake agent: start" }), ev({ type: "error", message: "Agent nie odpowiedział" })]);
    expect(s).toMatchObject({ status: "error", error: "Agent nie odpowiedział", log: ["fake agent: start"] });
    s = chatReducer(s, ev({ type: "exited", code: 1, message: null }));
    expect(s).toMatchObject({ status: "exited", error: "Agent nie odpowiedział" });
    const long = run(Array.from({ length: 250 }, (_, i) => ev({ type: "log", line: `l${i}` })));
    expect(long.log).toHaveLength(200);
    expect(long.log[199]).toBe("l249");
  });

  it("finds commands while their name is typed", () => {
    const commands = [
      { name: "review", description: "" },
      { name: "init", description: "" },
      { name: "Restart", description: "" },
    ];
    expect(matchingCommands(commands, "/").map((c) => c.name)).toEqual(["review", "init", "Restart"]);
    expect(matchingCommands(commands, "/r").map((c) => c.name)).toEqual(["review", "Restart"]);
    expect(matchingCommands(commands, "/review zmiany")).toEqual([]);
    expect(matchingCommands(commands, "napisz /r")).toEqual([]);
  });

  it("describes non-text content", () => {
    expect(blockText({ type: "resource_link", uri: "file:///a.ts", name: "a.ts" })).toBe("[a.ts]");
    expect(blockText({ type: "image", mimeType: "image/png" })).toBe("[obraz]");
    expect(blockText(undefined)).toBe("");
  });
});
