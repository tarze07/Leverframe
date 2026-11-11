import { Channel, invoke } from "@tauri-apps/api/core";

/** Events of an ACP session (see src-tauri/src/acp/session.rs `AcpEvent`). */
export type AcpEvent =
  | { type: "initialized"; agentInfo: { name?: string; title?: string; version?: string } | null; agentCapabilities: unknown; authMethods: AuthMethod[] }
  | { type: "authRequired"; authMethods: AuthMethod[]; message: string }
  | { type: "sessionReady"; sessionId: string; cwd: string; modes: unknown; configOptions: unknown }
  | { type: "update"; update: SessionUpdate }
  | { type: "permission"; requestId: number; toolCall: { title?: string; kind?: string } & Record<string, unknown>; options: PermissionOption[] }
  | { type: "permissionClosed"; requestId: number }
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

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** A `session/update` (ACP v1); only the fields this UI reads are typed. */
export type SessionUpdate = { sessionUpdate: string; content?: { type: string; text?: string } } & Record<string, unknown>;

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
  authenticate(methodId: string): Promise<void>;
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
    authenticate: (methodId) => invoke("acp_authenticate", { id, methodId }),
    stop: () => invoke("acp_stop", { id }),
  };
}
