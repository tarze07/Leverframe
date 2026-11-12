import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { logFilePath, openAgent } from "../../workbench/commands";
import { startAcp, type AcpEvent, type AcpHandle, type AcpStartRequest } from "./acpClient";
import { canContinue, chatReducer, initialChat, type ChatState } from "./chatState";
import { transcriptActions, transcriptTerminalEvents } from "./transcript";
import { AgentSessions } from "./AgentSessions";
import { sessionsClient } from "../sessions/sessionsClient";
import { ChatMarkdown } from "./ChatMarkdown";
import { PlanView } from "./PlanView";
import { PromptBox } from "./PromptBox";
import { SessionControls } from "./SessionControls";
import { ToolCard } from "./ToolCard";
import { PermissionCard } from "./PermissionCard";
import { serveFsRequest, type FsRequest } from "./agentFiles";
import { agentTerminalKey, useAgentTerminalsStore } from "../../store/agentTerminals";
import { useSettingsStore } from "../../store/settings";

export interface AgentChatParams {
  agentId: string;
  profileId?: string | null;
  cwd?: string | null;
  /** A conversation from the history (row in the sessions database): shown read only until resumed. */
  historyId?: number | null;
  /** The agent's id of that conversation. */
  acpSessionId?: string | null;
}

const STATUS: Record<ChatState["status"], string> = {
  starting: "Łączenie z agentem…",
  auth: "Wymagane logowanie",
  ready: "Gotowy",
  busy: "Agent pracuje…",
  error: "Błąd",
  exited: "Agent zakończył działanie",
  history: "Historia",
};

const number = (n: number) => n.toLocaleString("pl-PL");

/** Context use and cost, when the agent reports them (`usage_update`). */
function usageText(usage: ChatState["usage"]): string | null {
  if (!usage) return null;
  const pct = usage.size > 0 ? ` (${Math.round((usage.used / usage.size) * 100)}%)` : "";
  const cost = usage.cost ? ` · ${usage.cost.amount.toLocaleString("pl-PL", { maximumFractionDigits: 2 })} ${usage.cost.currency}` : "";
  return `kontekst ${number(usage.used)} / ${number(usage.size)}${pct}${cost}`;
}

/** Conversation with an agent over the Agent Client Protocol. */
export function AgentChatPanel(props: IDockviewPanelProps<AgentChatParams>) {
  if (!isTauri()) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="comment-discussion" title="Rozmowa z agentem działa w aplikacji desktopowej" />
      </div>
    );
  }
  return <Chat {...props} />;
}

/** Serves a file request and answers the agent. */
async function serveAndReply(req: FsRequest, h: AcpHandle | null, mtimes: Map<string, number>) {
  if (!h) return;
  const reply = await serveFsRequest(req, mtimes);
  await h.replyFs(req.requestId, "error" in reply ? { error: reply.error } : "content" in reply ? { content: reply.content } : {});
}

function Chat({ params, api }: IDockviewPanelProps<AgentChatParams>) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const handle = useRef<AcpHandle | null>(null);
  // What this session's agent read (for conflict checks on write) and file requests awaiting the user.
  const mtimes = useRef(new Map<string, number>());
  const pendingFs = useRef(new Map<number, FsRequest>());
  // Commands the user allowed "always" in this conversation.
  const allowedCommands = useRef(new Set<string>());
  const chatId = api?.id ?? "chat";
  const bottom = useRef<HTMLDivElement>(null);
  const agent = useAgentsStore((s) => s.agentById(params.agentId));
  const profile = useProfilesStore((s) => s.byId(params.profileId ?? s.defaultProfileId));
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(params.historyId != null);
  const [showSessions, setShowSessions] = useState(false);
  // The running agent, for rendering (the ref is for callbacks).
  const [liveHandle, setLiveHandle] = useState<AcpHandle | null>(null);
  // Ends the agent process of this panel (set while one runs).
  const stopAgent = useRef<(() => void) | null>(null);

  const terminalEvent = useCallback(
    (event: AcpEvent) => {
      const terminals = useAgentTerminalsStore.getState();
      if (event.type === "terminalStarted") terminals.start(agentTerminalKey(chatId, event.terminalId), event.command, event.cwd);
      else if (event.type === "terminalOutput") terminals.append(agentTerminalKey(chatId, event.terminalId), event.data);
      else if (event.type === "terminalExit") terminals.exit(agentTerminalKey(chatId, event.terminalId), event.exitCode, event.signal);
    },
    [chatId],
  );

  /** Starts the panel's agent process: a new conversation, or one to resume. */
  const connect = (resume?: AcpStartRequest["resume"]) => {
    let disposed = false;
    let started: AcpHandle | null = null;
    startAcp({ agentId: params.agentId, profileId: params.profileId, cwd: params.cwd, resume }, (event) => {
      if (disposed) return;
      if (event.type === "terminalRequest") {
        // Without asking: when the user turned it off, or allowed this command for the conversation.
        const ask = useSettingsStore.getState().values.acpConfirmCommands !== false;
        if (!ask || allowedCommands.current.has(event.command)) {
          void handle.current?.replyTerminal(event.requestId, true).catch(() => undefined);
          return;
        }
      }
      terminalEvent(event);
      dispatch({ type: "event", event });
      if (event.type === "fsRequest") {
        // Inside the session folder: served at once. Outside: the user decides (card below).
        if (event.inside) void serveAndReply(event, handle.current, mtimes.current).catch(() => undefined);
        else pendingFs.current.set(event.requestId, event);
      } else if (event.type === "fsClosed") {
        pendingFs.current.delete(event.requestId);
      }
    })
      .then((h) => {
        started = h;
        if (disposed) void h.stop().catch(() => undefined);
        else {
          handle.current = h;
          setLiveHandle(h);
        }
      })
      .catch((e: unknown) => !disposed && dispatch({ type: "failed", message: String(e) }));
    stopAgent.current = () => {
      disposed = true;
      handle.current = null;
      setLiveHandle(null);
      void started?.stop().catch(() => undefined);
    };
  };

  // A new conversation: one agent process for the panel's lifetime. From the history: the
  // transcript, read only; the agent starts only when the user resumes the conversation.
  useEffect(() => {
    let disposed = false;
    if (params.historyId != null) {
      sessionsClient
        .read(params.historyId)
        .then((text) => {
          if (disposed) return;
          const actions = transcriptActions(text);
          transcriptTerminalEvents(actions).forEach(terminalEvent);
          actions.forEach(dispatch);
          dispatch({ type: "historyLoaded" });
        })
        .catch((e: unknown) => !disposed && setHistoryError(String(e)))
        .finally(() => !disposed && setHistoryLoading(false));
    } else {
      connect();
    }
    return () => {
      disposed = true;
      stopAgent.current?.();
      stopAgent.current = null;
    };
    // The panel's agent, profile, folder and history entry are fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionId = state.sessionId ?? params.acpSessionId ?? null;
  const resume = () => {
    if (!sessionId || params.historyId == null) return;
    dispatch({ type: "resumed" });
    connect({ sessionId, historyId: params.historyId });
  };

  /** Opens one of the agent's saved sessions in this panel (the agent replays it). */
  const openAgentSession = (id: string) => {
    setShowSessions(false);
    dispatch({ type: "reset" });
    run((h) => h.loadSession(id));
  };

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.items, state.tools, state.permissions, state.fileApprovals, state.commandApprovals]);

  // The tab shows when the agent waits for a decision (the panel may be in the background).
  const waiting = state.permissions.length + state.fileApprovals.length + state.commandApprovals.length > 0;
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (typeof api?.setTitle !== "function") return;
    baseTitle.current ??= api.title ?? null;
    const base = baseTitle.current ?? "";
    api.setTitle(waiting ? `⚑ ${base}` : base);
  }, [api, waiting]);

  const decideFile = (requestId: number, allow: boolean) => {
    const req = pendingFs.current.get(requestId);
    const h = handle.current;
    if (!req || !h) return;
    pendingFs.current.delete(requestId);
    if (allow) void serveAndReply(req, h, mtimes.current).catch((e: unknown) => dispatch({ type: "failed", message: String(e) }));
    else run((x) => x.replyFs(requestId, { error: "Użytkownik nie zezwolił na dostęp do pliku spoza folderu projektu." }));
  };

  // Keys 1–9 choose an option of the first permission request (unless typing a message).
  const onKeyDown = (e: React.KeyboardEvent) => {
    const first = state.permissions[0];
    if (!first || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
    const target = e.target as HTMLElement;
    if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value !== "") return;
    const option = first.options[Number(e.key) - 1];
    if (!option) return;
    e.preventDefault();
    run((h) => h.replyPermission(first.requestId, option.optionId));
  };

  /** A path the agent mentions, as a file this machine can open (not on SSH hosts). */
  const toLocal = useCallback(
    (path: string) => (profile?.kind === "ssh" ? null : logFilePath(path, state.cwd, profile?.id ?? "")),
    [profile, state.cwd],
  );

  const run = (action: (h: AcpHandle) => Promise<unknown>) => {
    const h = handle.current;
    if (h) void action(h).catch((e: unknown) => dispatch({ type: "failed", message: String(e) }));
  };

  const send = (text: string) => {
    const h = handle.current;
    if (!h) return;
    dispatch({ type: "sent", text });
    h.prompt(text).then(
      (stopReason) => dispatch({ type: "turnEnded", stopReason }),
      (e: unknown) => dispatch({ type: "failed", message: String(e) }),
    );
  };

  const title = state.agentName ?? agent?.name ?? params.agentId;
  const usage = usageText(state.usage);
  const install = agent?.acp?.install ?? [];
  return (
    <div className="flex h-full flex-col bg-lf-editor text-xs" data-testid="agent-chat" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-2 border-b border-lf-border px-3 py-1.5" aria-label="Sesja agenta">
        <span className="codicon codicon-comment-discussion text-lf-muted" aria-hidden />
        <span className="font-semibold text-lf-fg">{title}</span>
        {state.agentVersion && <span className="text-lf-subtle">{state.agentVersion}</span>}
        <span className="min-w-0 flex-1 truncate text-lf-subtle" title={state.cwd ?? undefined}>
          {[state.title, profile?.name, state.cwd].filter(Boolean).join(" · ")}
        </span>
        {usage && (
          <span className="shrink-0 text-lf-subtle" title="Zużycie kontekstu (i koszt), jeśli agent je podaje">
            {usage}
          </span>
        )}
        {state.abilities.list && state.status === "ready" && liveHandle && (
          <button
            type="button"
            title="Rozmowy zapisane przez agenta w tym folderze"
            aria-expanded={showSessions}
            onClick={() => setShowSessions((v) => !v)}
            className="shrink-0 rounded px-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
          >
            <span className="codicon codicon-history align-middle" aria-hidden /> Rozmowy agenta
          </button>
        )}
        <span role="status" className={`shrink-0 ${state.status === "error" ? "text-lf-danger" : "text-lf-muted"}`}>
          {historyLoading ? "Wczytywanie historii…" : STATUS[state.status]}
        </span>
      </header>
      {showSessions && liveHandle && (
        <AgentSessions
          handle={liveHandle}
          currentId={state.sessionId}
          canDelete={state.abilities.delete}
          onOpen={openAgentSession}
          onClose={() => setShowSessions(false)}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2" aria-label="Rozmowa" role="log">
        {historyError && (
          <p role="alert" className="mb-2 rounded border border-lf-danger/50 p-2 text-lf-danger">
            Nie udało się wczytać rozmowy: {historyError}
          </p>
        )}
        {state.items.length === 0 && state.status === "ready" && (
          <p className="text-lf-subtle">
            Napisz, co agent ma zrobić.{state.commands.length > 0 && " Wpisz „/”, aby zobaczyć komendy agenta."}
          </p>
        )}
        {state.items.map((item, i) => {
          switch (item.kind) {
            case "message":
              if (item.role === "user")
                return (
                  <div key={i} className="mb-2 ml-8 whitespace-pre-wrap rounded bg-lf-hover px-2 py-1.5 font-mono text-lf-fg">
                    {item.text}
                  </div>
                );
              if (item.role === "thought")
                return (
                  <details key={i} className="mb-2 text-lf-subtle">
                    <summary className="cursor-pointer select-none">Rozumowanie</summary>
                    <div className="whitespace-pre-wrap pl-3 pt-1 italic">{item.text}</div>
                  </details>
                );
              return (
                <div key={i} className="group relative mb-2">
                  <ChatMarkdown text={item.text} toLocal={toLocal} />
                  <button
                    type="button"
                    title="Kopiuj odpowiedź"
                    aria-label="Kopiuj odpowiedź"
                    onClick={() => void writeText(item.text).catch(() => undefined)}
                    className="absolute right-0 top-0 hidden rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg group-hover:block"
                  >
                    <span className="codicon codicon-copy" aria-hidden />
                  </button>
                </div>
              );
            case "tool": {
              const tool = state.tools[item.id];
              const awaiting = state.permissions.some((p) => p.toolCall.toolCallId === tool?.id);
              return tool ? (
                <ToolCard
                  key={i}
                  tool={tool}
                  toLocal={toLocal}
                  awaitingPermission={awaiting}
                  terminalKey={(id) => agentTerminalKey(chatId, id)}
                />
              ) : null;
            }
            case "plan":
              return <PlanView key={i} entries={item.entries} />;
            case "notice":
              return (
                <p key={i} className="mb-2 text-lf-muted">
                  {item.text}
                </p>
              );
          }
        })}

        {state.permissions.map((p, i) => (
          <PermissionCard
            key={p.requestId}
            title={p.title}
            toolCall={p.toolCall}
            options={p.options}
            shortcuts={i === 0}
            toLocal={toLocal}
            onChoose={(optionId) => run((h) => h.replyPermission(p.requestId, optionId))}
          />
        ))}

        {state.commandApprovals.map((c) => (
          <div key={c.requestId} role="group" aria-label="Polecenie agenta" className="mb-2 rounded border border-lf-accent/60 bg-lf-elevated p-2">
            <p className="mb-1 text-lf-fg">
              <span className="codicon codicon-terminal align-middle text-lf-accent" aria-hidden /> Agent chce uruchomić polecenie
              {c.cwd && (
                <>
                  {" "}
                  w <span className="font-mono text-[11px] text-lf-muted">{c.cwd}</span>
                </>
              )}
              :
            </p>
            <code className="mb-1.5 block whitespace-pre-wrap break-all rounded bg-lf-bg px-2 py-1 font-mono text-[11px] text-lf-fg">{c.command}</code>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => run((h) => h.replyTerminal(c.requestId, true))}
                className="rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90"
              >
                Uruchom
              </button>
              <button
                type="button"
                title="Do końca tej rozmowy to samo polecenie uruchomi się bez pytania"
                onClick={() => {
                  allowedCommands.current.add(c.command);
                  run((h) => h.replyTerminal(c.requestId, true));
                }}
                className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover"
              >
                Zawsze dla tego polecenia
              </button>
              <button
                type="button"
                onClick={() => run((h) => h.replyTerminal(c.requestId, false))}
                className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover"
              >
                Odmów
              </button>
            </div>
          </div>
        ))}

        {state.fileApprovals.map((f) => (
          <div key={f.requestId} role="group" aria-label="Dostęp do pliku" className="mb-2 rounded border border-lf-accent/60 bg-lf-elevated p-2">
            <p className="mb-1 text-lf-fg">
              <span className="codicon codicon-warning align-middle text-lf-accent" aria-hidden /> Agent chce{" "}
              {f.op === "write" ? "zapisać" : "odczytać"} plik spoza folderu projektu:
            </p>
            <code className="mb-1.5 block break-all rounded bg-lf-bg px-2 py-1 font-mono text-[11px]">{f.path}</code>
            <div className="flex gap-1">
              <button type="button" onClick={() => decideFile(f.requestId, true)} className="rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90">
                Zezwól
              </button>
              <button type="button" onClick={() => decideFile(f.requestId, false)} className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover">
                Odmów
              </button>
            </div>
          </div>
        ))}

        {state.status === "auth" && (
          <div role="group" aria-label="Logowanie" className="mb-2 rounded border border-lf-border bg-lf-elevated p-2">
            <p className="mb-1.5 text-lf-fg">{state.authMessage || "Agent wymaga zalogowania."}</p>
            <div className="flex flex-wrap gap-1">
              {state.authMethods
                .filter((m) => m.type !== "terminal")
                .map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={m.description ?? undefined}
                    onClick={() => run((h) => h.authenticate(m.id))}
                    className="rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90"
                  >
                    {m.name}
                  </button>
                ))}
              <button
                type="button"
                onClick={() => openAgent(params.agentId, { profileId: params.profileId, cwd: params.cwd })}
                className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover"
              >
                Zaloguj w terminalu
              </button>
            </div>
          </div>
        )}

        {state.missingProgram && (
          <div role="alert" className="mb-2 rounded border border-lf-danger/50 p-2 text-lf-fg">
            <p className="mb-1">
              Nie znaleziono programu trybu rozmowy <code className="font-mono">{agent?.acp?.command ?? params.agentId}</code> w profilu{" "}
              {profile?.name ?? "domyślnym"}.
            </p>
            {install.map((h) => (
              <code key={h.command} className="mb-1 block rounded bg-lf-bg p-1 font-mono text-[11px]">
                {h.command}
              </code>
            ))}
            <p className="text-[11px] text-lf-subtle">Zainstaluj go w terminalu tego profilu i otwórz rozmowę ponownie.</p>
          </div>
        )}
        {state.error && !state.missingProgram && (
          <p role="alert" className="mb-2 whitespace-pre-wrap rounded border border-lf-danger/50 p-2 font-mono text-lf-danger">
            {state.error}
          </p>
        )}
        <div ref={bottom} />
      </div>

      {state.log.length > 0 && (
        <details className="shrink-0 border-t border-lf-border px-3 py-1 text-[11px]">
          <summary className="cursor-pointer text-lf-subtle">Log agenta ({state.log.length})</summary>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-lf-muted">{state.log.join("\n")}</pre>
        </details>
      )}

      {state.status === "history" ? (
        <HistoryBar canResume={canContinue(state.abilities) && !!sessionId && !!agent?.acp} agentKnown={!!agent?.acp} onResume={resume} />
      ) : (
        <>
          <SessionControls
            modes={state.modes}
            options={state.configOptions}
            disabled={state.status !== "ready"}
            onMode={(modeId) => {
              dispatch({ type: "modeChosen", modeId });
              run((h) => h.setMode(modeId));
            }}
            onOption={(configId, value) => {
              dispatch({ type: "optionChosen", configId, value });
              run((h) => h.setConfigOption(configId, value));
            }}
          />
          <PromptBox
            commands={state.commands}
            disabled={state.status === "exited" || state.status === "starting"}
            canSend={state.status === "ready"}
            busy={state.status === "busy"}
            placeholder={state.status === "ready" ? "Wiadomość (Enter – wyślij, Shift+Enter – nowa linia, / – komendy)" : ""}
            onSend={send}
            onStop={() => run((h) => h.cancel())}
          />
        </>
      )}
    </div>
  );
}

/** Below a conversation from the history: continue it, or why it cannot be continued. */
function HistoryBar({ canResume, agentKnown, onResume }: { canResume: boolean; agentKnown: boolean; onResume: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-lf-border px-3 py-2" aria-label="Rozmowa z historii">
      <span className="codicon codicon-history text-lf-muted" aria-hidden />
      {canResume ? (
        <>
          <span className="min-w-0 flex-1 text-lf-muted">Rozmowa z historii (tylko do odczytu).</span>
          <button type="button" onClick={onResume} className="shrink-0 rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90">
            Wznów rozmowę
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-lf-muted">
          {agentKnown
            ? "Agent nie pozwala wznawiać rozmów – to tylko podgląd historii."
            : "Tego agenta nie ma w katalogu albo nie ma trybu rozmowy – to tylko podgląd historii."}
        </span>
      )}
    </div>
  );
}
