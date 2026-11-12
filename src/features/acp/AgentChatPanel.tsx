import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { openAgent } from "../../workbench/commands";
import { canContinue, type ChatState } from "./chatState";
import { AgentSessions } from "./AgentSessions";
import { ChatMarkdown } from "./ChatMarkdown";
import { PlanView } from "./PlanView";
import { PromptBox } from "./PromptBox";
import { SessionControls } from "./SessionControls";
import { ToolCard } from "./ToolCard";
import { PermissionCard } from "./PermissionCard";
import { agentTerminalKey } from "../../store/agentTerminals";
import {
  allowCommandAlways,
  chatHandle,
  chatToLocal,
  decideChatFile,
  dispatchChat,
  isWaiting,
  openAgentSessionInChat,
  resumeChat,
  runChat,
  sendChat,
  useChatsStore,
  type ChatEntry,
} from "../../store/chats";
import type { AcpHandle } from "./acpClient";

/** A tab shows one conversation of the "Rozmowy" list; closing the tab does not end it. */
export interface AgentChatParams {
  chatId: string;
}

export const CHAT_STATUS: Record<ChatState["status"], string> = {
  starting: "Łączenie z agentem…",
  auth: "Wymagane logowanie",
  ready: "Gotowy",
  busy: "Agent pracuje…",
  error: "Błąd",
  exited: "Agent zakończył działanie",
  history: "Historia",
};
const STATUS = CHAT_STATUS;

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
  const chat = useChatsStore((s) => (props.params?.chatId ? s.chats[props.params.chatId] : undefined));
  if (!isTauri()) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="comment-discussion" title="Rozmowa z agentem działa w aplikacji desktopowej" />
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="comment-discussion" title="Ta rozmowa została zakończona">
          Zakończone rozmowy znajdziesz w panelu „Sesje”, w zakładce „Historia”.{" "}
          {typeof props.api?.close === "function" && (
            <button type="button" onClick={() => props.api.close()} className="text-lf-accent hover:underline">
              Zamknij kartę
            </button>
          )}
        </Placeholder>
      </div>
    );
  }
  return <Chat chat={chat} api={props.api} />;
}

function Chat({ chat, api }: { chat: ChatEntry; api: IDockviewPanelProps<AgentChatParams>["api"] }) {
  const { id: chatId, params, state, historyLoading, historyError } = chat;
  const bottom = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const agent = useAgentsStore((s) => s.agentById(params.agentId));
  const profile = useProfilesStore((s) => s.byId(params.profileId ?? s.defaultProfileId));
  const [showSessions, setShowSessions] = useState(false);
  // The running agent (the conversation outlives this tab).
  const liveHandle: AcpHandle | null = chat.live ? chatHandle(chatId) : null;

  const sessionId = state.sessionId ?? params.acpSessionId ?? null;
  const resume = () => resumeChat(chatId);

  /** Opens one of the agent's saved sessions in this conversation (the agent replays it). */
  const openAgentSession = (id: string) => {
    setShowSessions(false);
    openAgentSessionInChat(chatId, id);
  };

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.items, state.tools, state.permissions, state.fileApprovals, state.commandApprovals]);

  // A click on the tab, a switch from the "Rozmowy" view or the tab becoming active: show the end.
  // A tab that was hidden or just opened gets its size and content over a few frames, so the end
  // is kept in view until the height stops changing (or the user scrolls).
  const scrollFrame = useRef(0);
  const scrollToEnd = useCallback(() => {
    cancelAnimationFrame(scrollFrame.current);
    let last = -1;
    let stable = 0;
    let placed = -1;
    const step = (frame: number) => {
      const el = log.current;
      if (!el) return;
      // The user scrolled up meanwhile: leave it there. (A tab growing taller also lowers
      // scrollTop, but then the view is still at the end.)
      const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (placed >= 0 && el.scrollTop < placed - 4 && fromEnd > 4) return;
      el.scrollTop = el.scrollHeight;
      placed = el.scrollTop;
      stable = el.clientHeight > 0 && el.scrollHeight === last ? stable + 1 : 0;
      last = el.scrollHeight;
      if (stable < 3 && frame < 60) scrollFrame.current = requestAnimationFrame(() => step(frame + 1));
    };
    scrollFrame.current = requestAnimationFrame(() => step(0));
  }, []);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    if (chat.scrollSeq > 0) scrollToEnd();
  }, [chat.scrollSeq, scrollToEnd]);
  useEffect(() => {
    if (typeof api?.onDidActiveChange !== "function") return;
    const sub = api.onDidActiveChange((e) => e.isActive && scrollToEnd());
    return () => sub.dispose();
  }, [api, scrollToEnd]);

  // The tab shows when the agent waits for a decision (the panel may be in the background).
  const waiting = isWaiting(state);
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (typeof api?.setTitle !== "function") return;
    baseTitle.current ??= api.title ?? null;
    const base = baseTitle.current ?? "";
    api.setTitle(waiting ? `⚑ ${base}` : base);
  }, [api, waiting]);

  const decideFile = (requestId: number, allow: boolean) => decideChatFile(chatId, requestId, allow);
  const run = (action: (h: AcpHandle) => Promise<unknown>) => runChat(chatId, action);
  const dispatch = (action: Parameters<typeof dispatchChat>[1]) => dispatchChat(chatId, action);
  const send = (text: string) => sendChat(chatId, text);

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
  // Recomputed when the profile or the session folder changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toLocal = useCallback((path: string) => chatToLocal(chatId, path), [chatId, profile, state.cwd]);

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

      <div ref={log} className="min-h-0 flex-1 overflow-auto px-3 py-2" aria-label="Rozmowa" role="log">
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
                onClick={() => allowCommandAlways(chatId, c.requestId, c.command)}
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
