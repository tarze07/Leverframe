import type { AcpEvent, AuthMethod, PermissionOption } from "./acpClient";

/** A conversation as plain text (stage A2; the full view with Markdown, tools and plan comes later). */
export interface ChatMessage {
  role: "user" | "agent" | "thought";
  text: string;
}

export type ChatStatus = "starting" | "auth" | "ready" | "busy" | "error" | "exited";

export interface ChatState {
  status: ChatStatus;
  agentName: string | null;
  agentVersion: string | null;
  cwd: string | null;
  messages: ChatMessage[];
  permissions: { requestId: number; title: string; options: PermissionOption[] }[];
  authMethods: AuthMethod[];
  authMessage: string | null;
  error: string | null;
  log: string[];
  /** Why the last turn ended, when it was not a normal end. */
  stopReason: string | null;
}

export const initialChat: ChatState = {
  status: "starting",
  agentName: null,
  agentVersion: null,
  cwd: null,
  messages: [],
  permissions: [],
  authMethods: [],
  authMessage: null,
  error: null,
  log: [],
  stopReason: null,
};

const MAX_LOG = 200;

/** Appends a chunk, joining it with the previous message of the same role. */
function appendChunk(messages: ChatMessage[], role: ChatMessage["role"], text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === role) return [...messages.slice(0, -1), { role, text: last.text + text }];
  return [...messages, { role, text }];
}

export type ChatAction =
  | { type: "event"; event: AcpEvent }
  | { type: "sent"; text: string }
  | { type: "turnEnded"; stopReason: string }
  | { type: "failed"; message: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sent":
      return { ...state, status: "busy", stopReason: null, messages: [...state.messages, { role: "user", text: action.text }] };
    case "turnEnded":
      return {
        ...state,
        status: state.status === "busy" ? "ready" : state.status,
        stopReason: action.stopReason === "end_turn" ? null : action.stopReason,
      };
    case "failed":
      return { ...state, status: state.status === "exited" ? "exited" : "error", error: action.message };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: ChatState, e: AcpEvent): ChatState {
  switch (e.type) {
    case "initialized":
      return {
        ...state,
        agentName: e.agentInfo?.title ?? e.agentInfo?.name ?? null,
        agentVersion: e.agentInfo?.version ?? null,
        authMethods: e.authMethods,
      };
    case "authRequired":
      return { ...state, status: "auth", authMethods: e.authMethods.length ? e.authMethods : state.authMethods, authMessage: e.message };
    case "sessionReady":
      return { ...state, status: "ready", cwd: e.cwd, authMessage: null, error: null };
    case "update": {
      const u = e.update;
      const text = u.content?.type === "text" ? (u.content.text ?? "") : "";
      if (u.sessionUpdate === "agent_message_chunk" && text) return { ...state, messages: appendChunk(state.messages, "agent", text) };
      if (u.sessionUpdate === "agent_thought_chunk" && text) return { ...state, messages: appendChunk(state.messages, "thought", text) };
      // Tool calls, plan, modes …: shown by the full conversation view (later stage).
      return state;
    }
    case "permission":
      return {
        ...state,
        permissions: [...state.permissions, { requestId: e.requestId, title: e.toolCall.title ?? "Agent prosi o zgodę", options: e.options }],
      };
    case "permissionClosed":
      return { ...state, permissions: state.permissions.filter((p) => p.requestId !== e.requestId) };
    case "log":
      return { ...state, log: [...state.log, e.line].slice(-MAX_LOG) };
    case "error":
      return { ...state, status: "error", error: e.message };
    case "exited":
      return {
        ...state,
        status: "exited",
        permissions: [],
        error: e.message ?? (state.status === "error" ? state.error : null),
      };
  }
}
