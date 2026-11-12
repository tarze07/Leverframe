import type { AcpEvent } from "./acpClient";
import { chatReducer, initialChat, type ChatAction, type ChatState } from "./chatState";

/**
 * A recorded conversation (src-tauri/src/sessions/transcript.rs): JSON lines with the events the
 * panel saw, the user's messages and the ends of turns. Replayed through the same reducer as a
 * live conversation, so the history looks exactly like the panel did.
 */

type Line =
  | { t: number; event: AcpEvent }
  | { t: number; sent: string }
  | { t: number; turnEnded: string }
  | { t: number; reset: true }
  | { t: number; resumed: true };

/** Turns transcript lines into reducer actions; unknown or broken lines are skipped. */
export function transcriptActions(text: string): ChatAction[] {
  const actions: ChatAction[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: Partial<Line> & Record<string, unknown>;
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      continue;
    }
    if (line.event && typeof line.event === "object") actions.push({ type: "event", event: line.event as AcpEvent });
    else if (typeof line.sent === "string") actions.push({ type: "sent", text: line.sent });
    else if (typeof line.turnEnded === "string") actions.push({ type: "turnEnded", stopReason: line.turnEnded });
    else if (line.reset === true) actions.push({ type: "reset" });
    else if (line.resumed === true) actions.push({ type: "resumed" });
  }
  return actions;
}

/** The conversation as it ended, read only. */
export function replayTranscript(text: string, start: ChatState = initialChat): ChatState {
  return chatReducer(transcriptActions(text).reduce(chatReducer, start), { type: "historyLoaded" });
}

/** Command output events of a transcript (for the terminal store, which the tool cards read). */
export function transcriptTerminalEvents(actions: ChatAction[]) {
  return actions.flatMap((a) =>
    a.type === "event" && (a.event.type === "terminalStarted" || a.event.type === "terminalOutput" || a.event.type === "terminalExit")
      ? [a.event]
      : [],
  );
}
