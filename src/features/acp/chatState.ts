import type {
  AcpEvent,
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  ConfigOption,
  ContentBlock,
  ModeState,
  PermissionOption,
  PermissionToolCall,
  PlanEntry,
  SessionUpdate,
  ToolContent,
  ToolKind,
  ToolLocation,
  ToolStatus,
} from "./acpClient";

/**
 * State of one conversation with an ACP agent (one panel). A pure reducer over the agent's
 * events and the user's actions, so the whole conversation logic is testable without the UI.
 */

export interface ToolCallState {
  id: string;
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  locations: ToolLocation[];
  content: ToolContent[];
}

/** The conversation in order. Tool calls and plans are referenced, so updates change them in place. */
export type TimelineItem =
  | { kind: "message"; role: "user" | "agent" | "thought"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "notice"; text: string };

/** `history`: a conversation from the history, read only (until resumed). */
export type ChatStatus = "starting" | "auth" | "ready" | "busy" | "error" | "exited" | "history";

/** What the agent can do with saved sessions. */
export interface SessionAbilities {
  /** `session/load` (the agent replays the conversation). */
  load: boolean;
  /** `session/resume` (continues without a replay). */
  resume: boolean;
  list: boolean;
  delete: boolean;
}

export function sessionAbilities(caps: AgentCapabilities | null | undefined): SessionAbilities {
  const s = caps?.sessionCapabilities;
  const has = (v: unknown) => typeof v === "object" && v !== null;
  return { load: caps?.loadSession === true, resume: has(s?.resume), list: has(s?.list), delete: has(s?.delete) };
}

/** A conversation can be continued when the agent can load or resume sessions. */
export const canContinue = (a: SessionAbilities) => a.load || a.resume;

export interface ChatState {
  status: ChatStatus;
  agentName: string | null;
  agentVersion: string | null;
  abilities: SessionAbilities;
  /** The agent's id of this conversation. */
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  items: TimelineItem[];
  tools: Record<string, ToolCallState>;
  /** Index of this turn's plan in `items` (a plan is replaced by the agent as a whole). */
  planIndex: number | null;
  permissions: { requestId: number; title: string; toolCall: PermissionToolCall; options: PermissionOption[] }[];
  /** Files outside the session folder the agent wants: waiting for the user's decision. */
  fileApprovals: { requestId: number; op: "read" | "write"; path: string }[];
  /** Commands the agent wants to run: waiting for the user's decision. */
  commandApprovals: { requestId: number; command: string; cwd: string | null }[];
  commands: AvailableCommand[];
  modes: ModeState | null;
  configOptions: ConfigOption[];
  usage: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  authMethods: AuthMethod[];
  authMessage: string | null;
  error: string | null;
  /** The agent program was not found (exit code 127 from sh, 9009 from cmd.exe). */
  missingProgram: boolean;
  log: string[];
}

export const initialChat: ChatState = {
  status: "starting",
  agentName: null,
  agentVersion: null,
  abilities: { load: false, resume: false, list: false, delete: false },
  sessionId: null,
  cwd: null,
  title: null,
  items: [],
  tools: {},
  planIndex: null,
  permissions: [],
  fileApprovals: [],
  commandApprovals: [],
  commands: [],
  modes: null,
  configOptions: [],
  usage: null,
  authMethods: [],
  authMessage: null,
  error: null,
  missingProgram: false,
  log: [],
};

const MAX_LOG = 200;

export const STOP_REASONS: Record<string, string> = {
  cancelled: "Przerwano.",
  max_tokens: "Agent osiągnął limit długości odpowiedzi.",
  max_turn_requests: "Agent osiągnął limit kroków w tej turze.",
  refusal: "Agent odmówił wykonania.",
};

/** Text of a content block, or a short description of non-text content. */
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return "";
  switch (block.type) {
    case "text":
      return String((block as { text?: string }).text ?? "");
    case "resource_link":
      return `[${(block as { name?: string; uri: string }).name ?? (block as { uri: string }).uri}]`;
    case "resource":
      return String((block as { resource?: { text?: string; uri?: string } }).resource?.text ?? "");
    case "image":
      return "[obraz]";
    case "audio":
      return "[nagranie]";
    default:
      return "";
  }
}

function appendChunk(items: TimelineItem[], role: "user" | "agent" | "thought", text: string): TimelineItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "message" && last.role === role) return [...items.slice(0, -1), { ...last, text: last.text + text }];
  return [...items, { kind: "message", role, text }];
}

function applyUpdate(state: ChatState, u: SessionUpdate): ChatState {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const text = blockText((u as { content: ContentBlock }).content);
      if (!text) return state;
      const role = u.sessionUpdate === "agent_message_chunk" ? "agent" : u.sessionUpdate === "user_message_chunk" ? "user" : "thought";
      return { ...state, items: appendChunk(state.items, role, text) };
    }
    case "tool_call": {
      const t = u as Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
      const known = !!state.tools[t.toolCallId];
      const tool: ToolCallState = {
        id: t.toolCallId,
        title: t.title,
        kind: t.kind ?? "other",
        status: t.status ?? "pending",
        locations: t.locations ?? [],
        content: t.content ?? [],
      };
      return {
        ...state,
        tools: { ...state.tools, [tool.id]: tool },
        items: known ? state.items : [...state.items, { kind: "tool", id: tool.id }],
      };
    }
    case "tool_call_update": {
      const t = u as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;
      const prev = state.tools[t.toolCallId];
      // An update for an unknown call creates it (agents may skip the initial tool_call).
      const base: ToolCallState = prev ?? { id: t.toolCallId, title: "Narzędzie", kind: "other", status: "pending", locations: [], content: [] };
      const tool: ToolCallState = {
        ...base,
        title: t.title ?? base.title,
        kind: t.kind ?? base.kind,
        status: t.status ?? base.status,
        locations: t.locations ?? base.locations,
        content: t.content ?? base.content,
      };
      return {
        ...state,
        tools: { ...state.tools, [tool.id]: tool },
        items: prev ? state.items : [...state.items, { kind: "tool", id: tool.id }],
      };
    }
    case "plan": {
      const entries = (u as { entries: PlanEntry[] }).entries ?? [];
      if (state.planIndex !== null && state.items[state.planIndex]?.kind === "plan") {
        const items = state.items.slice();
        items[state.planIndex] = { kind: "plan", entries };
        return { ...state, items };
      }
      return { ...state, items: [...state.items, { kind: "plan", entries }], planIndex: state.items.length };
    }
    case "available_commands_update":
      return { ...state, commands: (u as { availableCommands: AvailableCommand[] }).availableCommands ?? [] };
    case "current_mode_update":
      return state.modes ? { ...state, modes: { ...state.modes, currentModeId: (u as { currentModeId: string }).currentModeId } } : state;
    case "config_option_update":
      return { ...state, configOptions: (u as { configOptions: ConfigOption[] }).configOptions ?? [] };
    case "session_info_update": {
      const title = (u as { title?: string | null }).title;
      return title === undefined ? state : { ...state, title };
    }
    case "usage_update": {
      const { used, size, cost } = u as { used: number; size: number; cost?: { amount: number; currency: string } | null };
      return { ...state, usage: { used, size, cost } };
    }
    default:
      return state;
  }
}

function applyEvent(state: ChatState, e: AcpEvent): ChatState {
  switch (e.type) {
    case "initialized":
      return {
        ...state,
        agentName: e.agentInfo?.title ?? e.agentInfo?.name ?? null,
        agentVersion: e.agentInfo?.version ?? null,
        abilities: sessionAbilities(e.agentCapabilities),
        authMethods: e.authMethods,
      };
    case "authRequired":
      return { ...state, status: "auth", authMethods: e.authMethods.length ? e.authMethods : state.authMethods, authMessage: e.message };
    case "sessionReady":
      return {
        ...state,
        status: "ready",
        sessionId: e.sessionId,
        cwd: e.cwd,
        modes: e.modes ?? state.modes,
        configOptions: e.configOptions ?? state.configOptions,
        authMessage: null,
        error: null,
      };
    case "update":
      return applyUpdate(state, e.update);
    case "permission":
      return {
        ...state,
        permissions: [
          ...state.permissions,
          { requestId: e.requestId, title: e.toolCall.title ?? "Agent prosi o zgodę", toolCall: e.toolCall, options: e.options },
        ],
      };
    case "permissionClosed":
      return { ...state, permissions: state.permissions.filter((p) => p.requestId !== e.requestId) };
    case "fsRequest":
      // Inside the session folder the panel serves requests at once; outside it asks first.
      return e.inside ? state : { ...state, fileApprovals: [...state.fileApprovals, { requestId: e.requestId, op: e.op, path: e.path }] };
    case "fsClosed":
      return { ...state, fileApprovals: state.fileApprovals.filter((f) => f.requestId !== e.requestId) };
    case "terminalRequest":
      return { ...state, commandApprovals: [...state.commandApprovals, { requestId: e.requestId, command: e.command, cwd: e.cwd }] };
    case "terminalRequestClosed":
      return { ...state, commandApprovals: state.commandApprovals.filter((c) => c.requestId !== e.requestId) };
    case "terminalStarted":
    case "terminalOutput":
    case "terminalExit":
      return state; // kept in the shared terminal store (the panel forwards them)
    case "log":
      return { ...state, log: [...state.log, e.line].slice(-MAX_LOG) };
    case "error":
      return { ...state, status: "error", error: e.message };
    case "exited": {
      const missing = (e.code === 127 || e.code === 9009) && (state.status === "starting" || state.status === "error");
      return {
        ...state,
        status: "exited",
        permissions: [],
        fileApprovals: [],
        commandApprovals: [],
        missingProgram: state.missingProgram || missing,
        error: e.message ?? (state.status === "error" ? state.error : null),
      };
    }
    default:
      // Events of other versions (e.g. in an older or newer transcript) change nothing.
      return state;
  }
}

export type ChatAction =
  | { type: "event"; event: AcpEvent }
  | { type: "sent"; text: string }
  | { type: "turnEnded"; stopReason: string }
  | { type: "failed"; message: string }
  | { type: "modeChosen"; modeId: string }
  | { type: "optionChosen"; configId: string; value: string | boolean }
  /** Another saved session opened in the panel: its replay starts a new timeline. */
  | { type: "reset" }
  /** The conversation continues (after a break, possibly in another agent process). */
  | { type: "resumed" }
  /** End of replaying a transcript: what was still open then is shown as finished. */
  | { type: "historyLoaded" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sent":
      return {
        ...state,
        status: "busy",
        planIndex: null, // a new turn gets its own plan
        items: [...state.items, { kind: "message", role: "user", text: action.text }],
      };
    case "turnEnded": {
      const notice = STOP_REASONS[action.stopReason] ?? (action.stopReason === "end_turn" ? null : `Koniec tury: ${action.stopReason}`);
      return {
        ...state,
        status: state.status === "busy" ? "ready" : state.status,
        items: notice ? [...state.items, { kind: "notice", text: notice }] : state.items,
      };
    }
    case "failed":
      return { ...state, status: state.status === "exited" ? "exited" : "error", error: action.message };
    case "modeChosen":
      return state.modes ? { ...state, modes: { ...state.modes, currentModeId: action.modeId } } : state;
    case "optionChosen":
      return {
        ...state,
        configOptions: state.configOptions.map((o) => (o.id === action.configId ? ({ ...o, currentValue: action.value } as ConfigOption) : o)),
      };
    case "event":
      return applyEvent(state, action.event);
    case "reset":
      return { ...state, items: [], tools: {}, planIndex: null, title: null, usage: null };
    case "resumed":
      return {
        ...state,
        status: "starting",
        error: null,
        missingProgram: false,
        items: [...state.items, { kind: "notice", text: "Rozmowa wznowiona." }],
      };
    case "historyLoaded":
      return {
        ...state,
        status: "history",
        permissions: [],
        fileApprovals: [],
        commandApprovals: [],
        missingProgram: false,
        error: null,
        log: [],
        // Tool calls interrupted by the end of the session are not running any more.
        tools: Object.fromEntries(
          Object.entries(state.tools).map(([id, t]) => [id, t.status === "pending" || t.status === "in_progress" ? { ...t, status: "failed" } : t]),
        ),
      };
  }
}

/** Commands matching what the user typed after "/" (only while the command name is typed). */
export function matchingCommands(commands: AvailableCommand[], input: string): AvailableCommand[] {
  const m = /^\/(\S*)$/.exec(input);
  if (!m) return [];
  const typed = m[1].toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(typed));
}
