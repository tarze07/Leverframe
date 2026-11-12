import { useState } from "react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { isWaiting, useChatsStore, type ChatEntry } from "../../store/chats";
import { useUiStore } from "../../store/ui";
import { chatTitle, endAgentChat, openChatPanel } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { CHAT_STATUS } from "./AgentChatPanel";

/** What a conversation is about: its title, or the beginning of the first message. */
function topic(chat: ChatEntry): string | null {
  if (chat.state.title) return chat.state.title;
  const first = chat.state.items.find((i) => i.kind === "message" && i.role === "user");
  return first?.kind === "message" ? first.text.split("\n")[0].slice(0, 80) : null;
}

/**
 * Sidebar view: the conversations with agents that are open, also when their tab is closed.
 * A click shows the conversation; it ends only here.
 */
export function ChatsView() {
  const order = useChatsStore((s) => s.order);
  if (!isTauri()) {
    return (
      <Placeholder icon="comment-discussion" title="Rozmowy z agentami">
        Rozmowy działają w aplikacji desktopowej.
      </Placeholder>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-3 pb-4">
      {order.length === 0 ? (
        <p className="py-4 text-center text-xs leading-relaxed text-lf-subtle">
          Brak otwartych rozmów. Rozpocznij ją przyciskiem <strong>Rozmowa</strong> w panelu{" "}
          <button type="button" className="text-lf-accent hover:underline" onClick={() => useUiStore.getState().selectView("agents")}>
            „Agenci”
          </button>
          . Zakończone rozmowy są w panelu „Sesje”, w zakładce „Historia”.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1" aria-label="Otwarte rozmowy">
            {[...order].reverse().map((id) => (
              <ChatRow key={id} id={id} />
            ))}
          </ul>
          <p className="text-[11px] leading-relaxed text-lf-subtle">
            Zamknięcie karty nie kończy rozmowy – agent pracuje dalej, a rozmowę otworzysz stąd ponownie. Kończy ją przycisk{" "}
            <span className="codicon codicon-debug-stop align-middle" aria-hidden /> <em>Zakończ</em>.
          </p>
        </>
      )}
    </div>
  );
}

function ChatRow({ id }: { id: string }) {
  const chat = useChatsStore((s) => s.chats[id]);
  const agentName = useAgentsStore((s) => (chat ? s.agentById(chat.params.agentId)?.name : undefined));
  const profileName = useProfilesStore((s) => (chat ? s.byId(chat.params.profileId ?? s.defaultProfileId)?.name : undefined));
  const [confirm, setConfirm] = useState(false);
  if (!chat) return null;
  const { state } = chat;
  const waiting = isWaiting(state);
  const working = state.status === "busy" || state.status === "starting";
  const subject = topic(chat);
  const status = waiting ? "czeka na decyzję" : chat.historyLoading ? "wczytywanie…" : CHAT_STATUS[state.status];
  const end = () => {
    setConfirm(false);
    endAgentChat(id);
  };
  return (
    <li className="group relative rounded hover:bg-lf-hover" aria-label={`Rozmowa ${chatTitle(chat)}`}>
      <button type="button" onClick={() => openChatPanel(id)} className="flex w-full flex-col gap-0.5 px-2 py-1.5 pr-8 text-left">
        <div className="flex items-center gap-1.5">
          <span
            className={`codicon ${waiting ? "codicon-bell-dot text-lf-accent" : working ? "codicon-loading codicon-modifier-spin text-lf-muted" : "codicon-comment-discussion text-lf-muted"} shrink-0`}
            aria-hidden
          />
          <span className="truncate text-[13px] text-lf-fg">{state.agentName ?? agentName ?? chat.params.agentId}</span>
          {profileName && <span className="truncate text-[11px] text-lf-subtle">{profileName}</span>}
        </div>
        {subject && <span className="truncate text-[12px] text-lf-fg/90">{subject}</span>}
        <span className="flex items-center gap-1.5 text-[11px] text-lf-muted">
          <span className={waiting ? "font-semibold text-lf-accent" : state.status === "error" ? "text-lf-danger" : ""}>{status}</span>
          {chat.params.cwd && (
            <span className="truncate" title={chat.params.cwd}>
              · {folderName(chat.params.cwd)}
            </span>
          )}
        </span>
      </button>
      {confirm ? (
        <div className="flex items-center gap-2 px-2 pb-1.5 text-xs">
          <span className="text-lf-fg">Agent jeszcze pracuje. Zakończyć?</span>
          <button type="button" onClick={end} className="rounded bg-lf-danger px-2 py-0.5 text-white">
            Zakończ
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="text-lf-muted hover:text-lf-fg">
            Anuluj
          </button>
        </div>
      ) : (
        <button
          type="button"
          title={chat.live ? "Zakończ rozmowę (zatrzymuje agenta)" : "Usuń z listy"}
          aria-label={chat.live ? "Zakończ rozmowę" : "Usuń z listy"}
          onClick={() => (working || waiting ? setConfirm(true) : end())}
          className="absolute right-1 top-1 rounded p-0.5 text-lf-muted hover:bg-lf-elevated hover:text-lf-fg"
        >
          <span className={`codicon ${chat.live ? "codicon-debug-stop" : "codicon-close"}`} aria-hidden />
        </button>
      )}
    </li>
  );
}
