import { describe, expect, it } from "vitest";
import { replayTranscript, transcriptActions, transcriptTerminalEvents } from "./transcript";

const line = (o: object) => JSON.stringify({ t: 1, ...o });
const event = (e: object) => line({ event: e });
const chunk = (text: string, kind = "agent_message_chunk") => event({ type: "update", update: { sessionUpdate: kind, content: { type: "text", text } } });
const ready = event({ type: "sessionReady", sessionId: "s-1", cwd: "/p", modes: null, configOptions: null });

describe("transcript", () => {
  it("replays a conversation through the chat reducer, read only", () => {
    const text = [
      JSON.stringify({ leverframe: "acp-transcript", version: 1 }),
      event({ type: "initialized", agentInfo: { name: "fake" }, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] }),
      ready,
      line({ sent: "Pierwsze" }),
      chunk("Odpowiedź "),
      chunk("pierwsza"),
      event({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Czytam", status: "in_progress" } }),
      event({ type: "fromANewerVersion" }),
      line({ turnEnded: "cancelled" }),
      "{zepsute",
      "",
      line({ resumed: true }),
      ready,
      line({ sent: "Drugie" }),
      event({ type: "terminalRequest", requestId: 4, command: "ls", cwd: null }),
    ].join("\n");
    const state = replayTranscript(text);
    expect(state.status).toBe("history");
    expect(state.sessionId).toBe("s-1");
    expect(state.abilities).toEqual({ load: false, resume: true, list: false, delete: false });
    expect(state.items).toEqual([
      { kind: "message", role: "user", text: "Pierwsze" },
      { kind: "message", role: "agent", text: "Odpowiedź pierwsza" },
      { kind: "tool", id: "t" },
      { kind: "notice", text: "Przerwano." },
      { kind: "notice", text: "Rozmowa wznowiona." },
      { kind: "message", role: "user", text: "Drugie" },
    ]);
    expect(state.tools.t.status).toBe("failed"); // the session ended while it ran
    expect(state.commandApprovals).toEqual([]);
  });

  it("starts over where another session was opened", () => {
    const state = replayTranscript([line({ sent: "Stara" }), line({ reset: true }), chunk("Napraw testy", "user_message_chunk")].join("\n"));
    expect(state.items).toEqual([{ kind: "message", role: "user", text: "Napraw testy" }]);
  });

  it("finds the output of commands for the terminal store", () => {
    const actions = transcriptActions(
      [
        event({ type: "terminalStarted", terminalId: "x", command: "ls", cwd: null }),
        event({ type: "terminalOutput", terminalId: "x", data: "a\n" }),
        event({ type: "update", update: { sessionUpdate: "plan", entries: [] } }),
        event({ type: "terminalExit", terminalId: "x", exitCode: 0, signal: null }),
      ].join("\n"),
    );
    expect(transcriptTerminalEvents(actions).map((e) => e.type)).toEqual(["terminalStarted", "terminalOutput", "terminalExit"]);
  });
});
