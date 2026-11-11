import { useCallback, useEffect, useReducer, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { logFilePath, openAgent } from "../../workbench/commands";
import { startAcp, type AcpHandle } from "./acpClient";
import { chatReducer, initialChat, type ChatState } from "./chatState";
import { ChatMarkdown } from "./ChatMarkdown";
import { PlanView } from "./PlanView";
import { PromptBox } from "./PromptBox";
import { SessionControls } from "./SessionControls";
import { ToolCard } from "./ToolCard";

export interface AgentChatParams {
  agentId: string;
  profileId?: string | null;
  cwd?: string | null;
}

const STATUS: Record<ChatState["status"], string> = {
  starting: "Łączenie z agentem…",
  auth: "Wymagane logowanie",
  ready: "Gotowy",
  busy: "Agent pracuje…",
  error: "Błąd",
  exited: "Agent zakończył działanie",
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

function Chat({ params }: IDockviewPanelProps<AgentChatParams>) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const handle = useRef<AcpHandle | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const agent = useAgentsStore((s) => s.agentById(params.agentId));
  const profile = useProfilesStore((s) => s.byId(params.profileId ?? s.defaultProfileId));

  // One agent process per panel, for the panel's lifetime.
  useEffect(() => {
    let disposed = false;
    let started: AcpHandle | null = null;
    startAcp({ agentId: params.agentId, profileId: params.profileId, cwd: params.cwd }, (event) => {
      if (!disposed) dispatch({ type: "event", event });
    })
      .then((h) => {
        started = h;
        if (disposed) void h.stop().catch(() => undefined);
        else handle.current = h;
      })
      .catch((e: unknown) => !disposed && dispatch({ type: "failed", message: String(e) }));
    return () => {
      disposed = true;
      handle.current = null;
      void started?.stop().catch(() => undefined);
    };
    // The panel's agent, profile and folder are fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.items, state.tools, state.permissions]);

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
    <div className="flex h-full flex-col bg-lf-editor text-xs" data-testid="agent-chat">
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
        <span role="status" className={`shrink-0 ${state.status === "error" ? "text-lf-danger" : "text-lf-muted"}`}>
          {STATUS[state.status]}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2" aria-label="Rozmowa" role="log">
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
              return tool ? <ToolCard key={i} tool={tool} toLocal={toLocal} /> : null;
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

        {state.permissions.map((p) => (
          <div key={p.requestId} role="group" aria-label="Prośba o zgodę" className="mb-2 rounded border border-lf-accent/60 bg-lf-elevated p-2">
            <p className="mb-1.5 text-lf-fg">
              <span className="codicon codicon-shield align-middle text-lf-accent" aria-hidden /> {p.title}
            </p>
            <div className="flex flex-wrap gap-1">
              {p.options.map((o) => (
                <button
                  key={o.optionId}
                  type="button"
                  title={o.kind.endsWith("always") ? "Agent zapamięta tę decyzję" : undefined}
                  onClick={() => run((h) => h.replyPermission(p.requestId, o.optionId))}
                  className={`rounded px-2 py-0.5 ${
                    o.kind.startsWith("allow") ? "bg-lf-accent text-lf-accent-fg hover:opacity-90" : "border border-lf-border text-lf-fg hover:bg-lf-hover"
                  }`}
                >
                  {o.name}
                </button>
              ))}
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
    </div>
  );
}
