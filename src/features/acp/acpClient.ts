import { Channel, invoke } from "@tauri-apps/api/core";

/** Events of an ACP session (see src-tauri/src/acp/session.rs `AcpEvent`). */
export type AcpEvent =
  | { type: "initialized"; agentInfo: { name?: string; title?: string; version?: string } | null; agentCapabilities: unknown; authMethods: AuthMethod[] }
  | { type: "authRequired"; authMethods: AuthMethod[]; message: string }
  | { type: "sessionReady"; sessionId: string; cwd: string; modes: ModeState | null; configOptions: ConfigOption[] | null }
  | { type: "update"; update: SessionUpdate }
  | { type: "permission"; requestId: number; toolCall: PermissionToolCall; options: PermissionOption[] }
  | { type: "permissionClosed"; requestId: number }
  | { type: "fsRequest"; requestId: number; op: "read" | "write"; path: string; inside: boolean; content: string | null }
  | { type: "fsClosed"; requestId: number }
  | { type: "terminalRequest"; requestId: number; command: string; cwd: string | null }
  | { type: "terminalRequestClosed"; requestId: number }
  | { type: "terminalStarted"; terminalId: string; command: string; cwd: string | null }
  | { type: "terminalOutput"; terminalId: string; data: string }
  | { type: "terminalExit"; terminalId: string; exitCode: number | null; signal: string | null }
  | { type: "log"; line: string }
  | { type: "error"; message: string }
  | { type: "exited"; code: number | null; message: string | null };

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** `terminal`: the user logs in by running the agent in a terminal. */
  type?: string;
}

/** What the agent wants to do: a tool call, possibly with diffs and its raw input (e.g. a command). */
export type PermissionToolCall = {
  toolCallId?: string;
  title?: string | null;
  kind?: ToolKind | null;
  content?: ToolContent[] | null;
  rawInput?: unknown;
  locations?: ToolLocation[] | null;
};

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** ACP v1 content block; text is shown, the others by name. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource: { uri: string; text?: string } }
  | { type: "image" | "audio"; mimeType?: string }
  | { type: string; [key: string]: unknown };

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolLocation {
  path: string;
  line?: number | null;
}

export type ToolContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface ModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export type ConfigOption = { id: string; name: string; description?: string | null; category?: string | null } & (
  | { type: "select"; currentValue: string; options: ConfigSelectOption[] | { group: string; name: string; options: ConfigSelectOption[] }[] }
  | { type: "boolean"; currentValue: boolean }
);

/** A `session/update` (ACP v1). Variants the UI reads are typed; unknown ones are ignored. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call"; toolCallId: string; title: string; kind?: ToolKind; status?: ToolStatus; content?: ToolContent[]; locations?: ToolLocation[] })
  | ({ sessionUpdate: "tool_call_update"; toolCallId: string; title?: string | null; kind?: ToolKind | null; status?: ToolStatus | null; content?: ToolContent[] | null; locations?: ToolLocation[] | null })
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpStartRequest {
  agentId?: string;
  command?: string[];
  profileId?: string | null;
  cwd?: string | null;
}

export interface AcpHandle {
  id: number;
  /** Resolves with the stop reason (`end_turn`, `cancelled`, `max_tokens`, …). */
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  replyPermission(requestId: number, optionId: string | null): Promise<void>;
  /** Answers a file request: the text read, nothing for a write, or an error. */
  replyFs(requestId: number, reply: { content?: string; error?: string }): Promise<void>;
  /** Runs (`allow`) or refuses a command the agent asked for. */
  replyTerminal(requestId: number, allow: boolean): Promise<void>;
  authenticate(methodId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  /** A select takes the value id, a boolean option `true` / `false`. */
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
  stop(): Promise<void>;
}

/** Starts an agent in ACP mode in the Rust backend; events arrive through `onEvent`. */
export async function startAcp(request: AcpStartRequest, onEvent: (event: AcpEvent) => void): Promise<AcpHandle> {
  const channel = new Channel<AcpEvent>(onEvent);
  const id = await invoke<number>("acp_start", {
    request: { agentId: request.agentId, command: request.command, profileId: request.profileId ?? null, cwd: request.cwd ?? null },
    onEvent: channel,
  });
  return {
    id,
    prompt: (text) => invoke<string>("acp_prompt", { id, text }),
    cancel: () => invoke("acp_cancel", { id }),
    replyPermission: (requestId, optionId) => invoke("acp_permission_reply", { id, requestId, optionId }),
    replyFs: (requestId, reply) =>
      invoke("acp_fs_reply", { id, requestId, content: reply.content ?? null, error: reply.error ?? null }),
    replyTerminal: (requestId, allow) => invoke("acp_terminal_reply", { id, requestId, allow }),
    authenticate: (methodId) => invoke("acp_authenticate", { id, methodId }),
    setMode: (modeId) => invoke("acp_set_mode", { id, modeId }),
    setConfigOption: (configId, value) => invoke("acp_set_config_option", { id, configId, value }),
    stop: () => invoke("acp_stop", { id }),
  };
}
