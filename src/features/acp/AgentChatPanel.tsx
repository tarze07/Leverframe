import { useEffect, useReducer, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { openAgent } from "../../workbench/commands";
import { startAcp, type AcpHandle } from "./acpClient";
import { chatReducer, initialChat, type ChatState } from "./chatState";

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

const STOP_REASONS: Record<string, string> = {
  cancelled: "Przerwano.",
  max_tokens: "Agent osiągnął limit długości odpowiedzi.",
  max_turn_requests: "Agent osiągnął limit kroków w tej turze.",
  refusal: "Agent odmówił wykonania.",
};

/** Conversation with an agent over ACP (stage A2: plain text; the full view comes in a later stage). */
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
  const [input, setInput] = useState("");
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
  }, [state.messages, state.permissions]);

  const send = () => {
    const text = input.trim();
    const h = handle.current;
    if (!text || !h || state.status !== "ready") return;
    setInput("");
    dispatch({ type: "sent", text });
    h.prompt(text).then(
      (stopReason) => dispatch({ type: "turnEnded", stopReason }),
      (e: unknown) => dispatch({ type: "failed", message: String(e) }),
    );
  };

  const run = (action: (h: AcpHandle) => Promise<unknown>) => {
    const h = handle.current;
    if (h) void action(h).catch((e: unknown) => dispatch({ type: "failed", message: String(e) }));
  };

  const title = state.agentName ?? agent?.name ?? params.agentId;
  return (
    <div className="flex h-full flex-col bg-lf-editor text-xs" data-testid="agent-chat">
      <header className="flex shrink-0 items-center gap-2 border-b border-lf-border px-3 py-1.5">
        <span className="codicon codicon-comment-discussion text-lf-muted" aria-hidden />
        <span className="font-semibold text-lf-fg">{title}</span>
        {state.agentVersion && <span className="text-lf-subtle">{state.agentVersion}</span>}
        <span className="min-w-0 flex-1 truncate text-lf-subtle" title={state.cwd ?? undefined}>
          {[profile?.name, state.cwd].filter(Boolean).join(" · ")}
        </span>
        <span role="status" className={state.status === "error" ? "text-lf-danger" : "text-lf-muted"}>
          {STATUS[state.status]}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2" aria-label="Rozmowa" role="log">
        {state.messages.length === 0 && state.status === "ready" && (
          <p className="text-lf-subtle">Napisz, co agent ma zrobić. Odpowiedź pojawi się tutaj.</p>
        )}
        {state.messages.map((m, i) => (
          <div
            key={i}
            className={`mb-2 whitespace-pre-wrap rounded px-2 py-1.5 font-mono leading-relaxed ${
              m.role === "user" ? "ml-8 bg-lf-hover text-lf-fg" : m.role === "thought" ? "italic text-lf-subtle" : "text-lf-fg"
            }`}
          >
            {m.text}
          </div>
        ))}
        {state.stopReason && <p className="mb-2 text-lf-muted">{STOP_REASONS[state.stopReason] ?? `Koniec tury: ${state.stopReason}`}</p>}

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

        {state.error && (
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

      <form
        className="flex shrink-0 items-end gap-1 border-t border-lf-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          aria-label="Wiadomość do agenta"
          value={input}
          rows={2}
          disabled={state.status === "exited" || state.status === "starting"}
          placeholder={state.status === "ready" ? "Wiadomość (Enter – wyślij, Shift+Enter – nowa linia)" : ""}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-h-0 flex-1 resize-none rounded border border-lf-border bg-lf-bg px-2 py-1 font-mono text-xs text-lf-fg outline-none focus:border-lf-accent disabled:opacity-50"
        />
        {state.status === "busy" ? (
          <button type="button" onClick={() => run((h) => h.cancel())} className="rounded border border-lf-border px-2 py-1 text-lf-fg hover:bg-lf-hover">
            <span className="codicon codicon-debug-stop align-middle" aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={state.status !== "ready" || !input.trim()}
            className="rounded bg-lf-accent px-2 py-1 text-lf-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            Wyślij
          </button>
        )}
      </form>
    </div>
  );
}
