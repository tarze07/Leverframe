import { create } from "zustand";
import { startAcp, type AcpEvent, type AcpHandle, type AcpStartRequest } from "../features/acp/acpClient";
import { chatReducer, initialChat, type ChatAction, type ChatState } from "../features/acp/chatState";
import { transcriptActions, transcriptTerminalEvents } from "../features/acp/transcript";
import { serveFsRequest, type FsRequest } from "../features/acp/agentFiles";
import { AgentEdits } from "../features/acp/agentEdits";
import { sessionsClient } from "../features/sessions/sessionsClient";
import { notifyFilesChanged } from "../lib/fileEvents";
import { logFilePath } from "../workbench/commands";
import { agentTerminalKey, useAgentTerminalsStore } from "./agentTerminals";
import { editorForPath } from "./editor";
import { useProfilesStore } from "./profiles";
import { useSettingsStore } from "./settings";

/**
 * Conversations with agents (ACP), independent of their tabs: the agent keeps running when a
 * tab is closed, and the "Rozmowy" view lists the conversations, opens them again and ends them.
 */

export interface ChatParams {
  agentId: string;
  profileId?: string | null;
  cwd?: string | null;
  /** A conversation from the history (row in the sessions database): read only until resumed. */
  historyId?: number | null;
  /** The agent's id of that conversation. */
  acpSessionId?: string | null;
}

export interface ChatEntry {
  id: string;
  params: ChatParams;
  state: ChatState;
  /** An agent process runs for this conversation. */
  live: boolean;
  historyLoading: boolean;
  historyError: string | null;
  createdAt: number;
  /** Grows when the conversation should be shown from its end (tab clicked, switched to). */
  scrollSeq: number;
}

interface ChatsStore {
  chats: Record<string, ChatEntry>;
  /** Oldest first. */
  order: string[];
}

export const useChatsStore = create<ChatsStore>()(() => ({ chats: {}, order: [] }));

/** What a conversation needs besides its state: the agent process and the requests it waits on. */
interface Runtime {
  handle: AcpHandle | null;
  /** Ends the agent process (set while one runs or starts). */
  stop: (() => void) | null;
  /** What the agent read (for conflict checks on write). */
  mtimes: Map<string, number>;
  /** File requests outside the session folder, waiting for the user. */
  pendingFs: Map<number, FsRequest>;
  /** Commands the user allowed "always" in this conversation. */
  allowedCommands: Set<string>;
  edits: AgentEdits;
}

const runtimes = new Map<string, Runtime>();
let counter = 0;

function runtime(id: string): Runtime {
  let r = runtimes.get(id);
  if (!r) {
    r = { handle: null, stop: null, mtimes: new Map(), pendingFs: new Map(), allowedCommands: new Set(), edits: new AgentEdits() };
    runtimes.set(id, r);
  }
  return r;
}

const patch = (id: string, change: (e: ChatEntry) => Partial<ChatEntry>) =>
  useChatsStore.setState((s) => (s.chats[id] ? { chats: { ...s.chats, [id]: { ...s.chats[id], ...change(s.chats[id]) } } } : s));

export function dispatchChat(id: string, action: ChatAction) {
  patch(id, (e) => ({ state: chatReducer(e.state, action) }));
}

/** Shows the end of the conversation in its tab. */
export function requestChatScroll(id: string) {
  patch(id, (e) => ({ scrollSeq: e.scrollSeq + 1 }));
}

export const chatById = (id: string): ChatEntry | undefined => useChatsStore.getState().chats[id];
export const chatHandle = (id: string): AcpHandle | null => runtimes.get(id)?.handle ?? null;

/** The agent waits for the user (permission, file outside the folder, command). */
export const isWaiting = (s: ChatState) => s.permissions.length + s.fileApprovals.length + s.commandApprovals.length > 0;

/** A path the agent mentions, as a file this machine can open (none on SSH hosts). */
export function chatToLocal(id: string, path: string): string | null {
  const chat = chatById(id);
  if (!chat) return null;
  const profiles = useProfilesStore.getState();
  const profile = profiles.byId(chat.params.profileId ?? profiles.defaultProfileId);
  return profile?.kind === "ssh" ? null : logFilePath(path, chat.state.cwd, profile?.id ?? "");
}

/** Starts a conversation: a new one with the agent, or one from the history (read only). */
export function createChat(params: ChatParams): string {
  const id = `chat-${params.agentId}-${Date.now()}-${++counter}`;
  const entry: ChatEntry = {
    id,
    params,
    state: initialChat,
    live: false,
    historyLoading: params.historyId != null,
    historyError: null,
    createdAt: Date.now(),
    scrollSeq: 0,
  };
  useChatsStore.setState((s) => ({ chats: { ...s.chats, [id]: entry }, order: [...s.order, id] }));
  if (params.historyId != null) loadHistory(id, params.historyId);
  else connectChat(id);
  return id;
}

/** The conversation showing this history entry, if one is open. */
export const chatForHistory = (historyId: number): string | undefined =>
  useChatsStore.getState().order.find((id) => chatById(id)?.params.historyId === historyId);

function terminalEvent(id: string, event: AcpEvent) {
  const terminals = useAgentTerminalsStore.getState();
  if (event.type === "terminalStarted") terminals.start(agentTerminalKey(id, event.terminalId), event.command, event.cwd);
  else if (event.type === "terminalOutput") terminals.append(agentTerminalKey(id, event.terminalId), event.data);
  else if (event.type === "terminalExit") terminals.exit(agentTerminalKey(id, event.terminalId), event.exitCode, event.signal);
}

function loadHistory(id: string, historyId: number) {
  sessionsClient
    .read(historyId)
    .then((text) => {
      if (!chatById(id)) return;
      const actions = transcriptActions(text);
      transcriptTerminalEvents(actions).forEach((e) => terminalEvent(id, e));
      patch(id, (e) => ({ state: chatReducer(actions.reduce(chatReducer, e.state), { type: "historyLoaded" }) }));
    })
    .catch((e: unknown) => patch(id, () => ({ historyError: String(e) })))
    .finally(() => patch(id, () => ({ historyLoading: false })));
}

/** Serves a file request and answers the agent. */
async function serveAndReply(req: FsRequest, h: AcpHandle | null, mtimes: Map<string, number>) {
  if (!h) return;
  const reply = await serveFsRequest(req, mtimes);
  await h.replyFs(req.requestId, "error" in reply ? { error: reply.error } : "content" in reply ? { content: reply.content } : {});
}

/** Files the agent changed with its own tools: open editors without unsaved changes and the file tree read them again. */
function refreshEdited(id: string, paths: string[]) {
  const local = paths.map((p) => chatToLocal(id, p)).filter((p): p is string => !!p);
  if (local.length === 0) return;
  for (const p of local) {
    const editor = editorForPath(p);
    if (editor && !editor.dirty) void editor.reload?.().catch(() => undefined);
  }
  notifyFilesChanged(local);
}

/** Starts the conversation's agent process: a new conversation, or one to resume. */
export function connectChat(id: string, resume?: AcpStartRequest["resume"]) {
  const chat = chatById(id);
  if (!chat) return;
  const rt = runtime(id);
  let disposed = false;
  let started: AcpHandle | null = null;
  const { agentId, profileId, cwd } = chat.params;
  startAcp({ agentId, profileId, cwd, resume }, (event) => {
    if (disposed) return;
    if (event.type === "terminalRequest") {
      // Without asking: when the user turned it off, or allowed this command for the conversation.
      const ask = useSettingsStore.getState().values.acpConfirmCommands !== false;
      if (!ask || rt.allowedCommands.has(event.command)) {
        void rt.handle?.replyTerminal(event.requestId, true).catch(() => undefined);
        return;
      }
    }
    terminalEvent(id, event);
    if (event.type === "update") refreshEdited(id, rt.edits.feed(event.update));
    dispatchChat(id, { type: "event", event });
    if (event.type === "fsRequest") {
      // Inside the session folder: served at once. Outside: the user decides.
      if (event.inside) void serveAndReply(event, rt.handle, rt.mtimes).catch(() => undefined);
      else rt.pendingFs.set(event.requestId, event);
    } else if (event.type === "fsClosed") {
      rt.pendingFs.delete(event.requestId);
    } else if (event.type === "exited") {
      rt.handle = null;
      patch(id, () => ({ live: false }));
    }
  })
    .then((h) => {
      started = h;
      if (disposed) void h.stop().catch(() => undefined);
      else {
        rt.handle = h;
        patch(id, (e) => ({ live: e.state.status !== "exited" }));
      }
    })
    .catch((e: unknown) => !disposed && dispatchChat(id, { type: "failed", message: String(e) }));
  rt.stop = () => {
    disposed = true;
    rt.handle = null;
    void started?.stop().catch(() => undefined);
  };
}

/** Runs an action on the agent; a failure is shown in the conversation. */
export function runChat(id: string, action: (h: AcpHandle) => Promise<unknown>) {
  const h = chatHandle(id);
  if (h) void action(h).catch((e: unknown) => dispatchChat(id, { type: "failed", message: String(e) }));
}

export function sendChat(id: string, text: string) {
  const h = chatHandle(id);
  if (!h) return;
  dispatchChat(id, { type: "sent", text });
  h.prompt(text).then(
    (stopReason) => dispatchChat(id, { type: "turnEnded", stopReason }),
    (e: unknown) => dispatchChat(id, { type: "failed", message: String(e) }),
  );
}

/** The user's decision on a file outside the session folder. */
export function decideChatFile(id: string, requestId: number, allow: boolean) {
  const rt = runtimes.get(id);
  const req = rt?.pendingFs.get(requestId);
  if (!rt || !req || !rt.handle) return;
  rt.pendingFs.delete(requestId);
  if (allow) void serveAndReply(req, rt.handle, rt.mtimes).catch((e: unknown) => dispatchChat(id, { type: "failed", message: String(e) }));
  else runChat(id, (h) => h.replyFs(requestId, { error: "Użytkownik nie zezwolił na dostęp do pliku spoza folderu projektu." }));
}

/** Runs the command and every later identical one in this conversation without asking. */
export function allowCommandAlways(id: string, requestId: number, command: string) {
  runtime(id).allowedCommands.add(command);
  runChat(id, (h) => h.replyTerminal(requestId, true));
}

/** Continues a conversation from the history with the agent. */
export function resumeChat(id: string) {
  const chat = chatById(id);
  const sessionId = chat?.state.sessionId ?? chat?.params.acpSessionId;
  if (!chat || !sessionId || chat.params.historyId == null) return;
  dispatchChat(id, { type: "resumed" });
  connectChat(id, { sessionId, historyId: chat.params.historyId });
}

/** Opens one of the agent's saved sessions in this conversation (the agent replays it). */
export function openAgentSessionInChat(id: string, sessionId: string) {
  dispatchChat(id, { type: "reset" });
  runChat(id, (h) => h.loadSession(sessionId));
}

/** Ends the conversation: stops its agent and removes it from the list (it stays in the history). */
export function endChat(id: string) {
  const rt = runtimes.get(id);
  rt?.stop?.();
  runtimes.delete(id);
  useAgentTerminalsStore.getState().forget(id);
  useChatsStore.setState((s) => {
    const chats = { ...s.chats };
    delete chats[id];
    return { chats, order: s.order.filter((c) => c !== id) };
  });
}

/** Ends every conversation (tests, application exit). */
export function endAllChats() {
  for (const id of [...useChatsStore.getState().order]) endChat(id);
}
