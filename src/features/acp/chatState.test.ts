import { describe, expect, it } from "vitest";
import type { AcpEvent } from "./acpClient";
import { chatReducer, initialChat, type ChatAction, type ChatState } from "./chatState";

const ev = (event: AcpEvent): ChatAction => ({ type: "event", event });
const run = (actions: ChatAction[], from: ChatState = initialChat) => actions.reduce(chatReducer, from);
const chunk = (sessionUpdate: string, text: string): ChatAction =>
  ev({ type: "update", update: { sessionUpdate, content: { type: "text", text } } });

describe("chat state", () => {
  it("goes from starting to ready and joins streamed chunks", () => {
    const s = run([
      ev({ type: "initialized", agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.68.0" }, agentCapabilities: {}, authMethods: [] }),
      ev({ type: "sessionReady", sessionId: "s1", cwd: "/home/me/app", modes: null, configOptions: null }),
      { type: "sent", text: "Cześć" },
      chunk("agent_thought_chunk", "myślę"),
      chunk("agent_message_chunk", "Dzień "),
      chunk("agent_message_chunk", "dobry"),
      ev({ type: "update", update: { sessionUpdate: "plan", entries: [] } }),
      { type: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(s).toMatchObject({ status: "ready", agentName: "Gemini CLI", agentVersion: "0.68.0", cwd: "/home/me/app", stopReason: null });
    expect(s.messages).toEqual([
      { role: "user", text: "Cześć" },
      { role: "thought", text: "myślę" },
      { role: "agent", text: "Dzień dobry" },
    ]);
  });

  it("keeps the reason of an unusual end of turn", () => {
    const ready = run([ev({ type: "sessionReady", sessionId: "s", cwd: "/", modes: null, configOptions: null }), { type: "sent", text: "x" }]);
    expect(ready.status).toBe("busy");
    expect(chatReducer(ready, { type: "turnEnded", stopReason: "cancelled" })).toMatchObject({ status: "ready", stopReason: "cancelled" });
  });

  it("tracks permission requests until they are closed", () => {
    const s = run([
      ev({ type: "permission", requestId: 1, toolCall: { title: "Uruchom npm test" }, options: [{ optionId: "a", name: "Zezwól", kind: "allow_once" }] }),
      ev({ type: "permission", requestId: 2, toolCall: {}, options: [] }),
      ev({ type: "permissionClosed", requestId: 1 }),
    ]);
    expect(s.permissions).toEqual([{ requestId: 2, title: "Agent prosi o zgodę", options: [] }]);
  });

  it("asks for login and recovers once the session starts", () => {
    const methods = [{ id: "oauth", name: "Zaloguj przez Google" }];
    const s = run([
      ev({ type: "initialized", agentInfo: null, agentCapabilities: {}, authMethods: methods }),
      ev({ type: "authRequired", authMethods: [], message: "Najpierw się zaloguj" }),
    ]);
    expect(s).toMatchObject({ status: "auth", authMethods: methods, authMessage: "Najpierw się zaloguj" });
    expect(chatReducer(s, ev({ type: "sessionReady", sessionId: "s", cwd: "/", modes: null, configOptions: null }))).toMatchObject({
      status: "ready",
      authMessage: null,
    });
  });

  it("reports errors and the end of the process, keeping the last log lines", () => {
    let s = run([ev({ type: "log", line: "fake agent: start" }), ev({ type: "error", message: "Agent nie odpowiedział" })]);
    expect(s).toMatchObject({ status: "error", error: "Agent nie odpowiedział", log: ["fake agent: start"] });
    s = chatReducer(s, ev({ type: "exited", code: 1, message: null }));
    expect(s).toMatchObject({ status: "exited", error: "Agent nie odpowiedział" });
    s = chatReducer(s, ev({ type: "exited", code: 3, message: "awaria" }));
    expect(s.error).toBe("awaria");
    const long = run(Array.from({ length: 250 }, (_, i) => ev({ type: "log", line: `l${i}` })));
    expect(long.log).toHaveLength(200);
    expect(long.log[199]).toBe("l249");
  });
});
