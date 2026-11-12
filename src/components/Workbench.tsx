import type { IDockviewHeaderActionsProps } from "dockview-react";
import { WelcomePanel } from "../features/editor/WelcomePanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { SessionPlayer } from "../features/sessions/SessionPlayer";
import { AgentLogPanel } from "../features/sessions/AgentLogPanel";
import { EditorPanel } from "../features/editor/EditorPanel";
import { EditorTab } from "../features/editor/EditorTab";
import { ChatTab } from "../features/acp/ChatTab";
import { AgentChatPanel } from "../features/acp/AgentChatPanel";
import { DiffPanel } from "../features/editor/DiffPanel";
import { DockArea } from "../workbench/DockArea";
import { useUiStore } from "../store/ui";

/** Panel components available in the central area. Editors (#8) register here. */
const components = {
  welcome: WelcomePanel,
  terminal: TerminalPanel,
  session: SessionPlayer,
  agentLog: AgentLogPanel,
  editor: EditorPanel,
  agentChat: AgentChatPanel,
  diff: DiffPanel,
};

const tabComponents = { editor: EditorTab, chat: ChatTab };

/** Shown at the right of the editor tab bar: editor over the whole center (terminal panel hidden) and back. */
function MaximizeEditorAction({ group }: IDockviewHeaderActionsProps) {
  const maximized = useUiStore((s) => s.maximized === "editor");
  const toggle = useUiStore((s) => s.toggleEditorMaximized);
  // Floating / popout groups have their own window chrome.
  if (group.api.location.type !== "grid") return null;
  const label = maximized ? "Przywróć panel terminala" : "Maksymalizuj edytor – ukryj terminal";
  return (
    <div className="flex h-full items-center px-1">
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={toggle}
        className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
      >
        <span className={`codicon codicon-${maximized ? "screen-normal" : "screen-full"}`} aria-hidden />
      </button>
    </div>
  );
}

/** Central editor/terminal area: tabs, splits, drag & drop, persisted layout. */
export function Workbench() {
  return (
    <DockArea
      id="main"
      components={components}
      tabComponents={tabComponents}
      rightHeaderActions={MaximizeEditorAction}
      addDefaultPanels={(api) => api.addPanel({ id: "welcome", component: "welcome", title: "Witaj" })}
    />
  );
}
