import { useUiStore, isSidePosition, turnedPosition } from "../store/ui";
import { isTauri } from "../lib/tauri";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { AgentChatPanel } from "../features/acp/AgentChatPanel";
import { AgentTerminalPanel } from "../features/acp/AgentTerminalPanel";
import { DockArea } from "../workbench/DockArea";
import { addTerminalPanel, closeActiveTerminal, openTerminal } from "../workbench/commands";
import { ProfileMenu } from "../features/profiles/ProfileMenu";
import { Placeholder } from "./Placeholder";
import { ChatTab } from "../features/acp/ChatTab";

/** Conversations here too: a click on their tab shows the end. */
const tabComponents = { chat: ChatTab };

// Conversations with agents can sit next to the terminals too.
const components = { terminal: TerminalPanel, agentChat: AgentChatPanel, agentTerminal: AgentTerminalPanel };

function EmptyPanel() {
  return (
    <div className="h-full bg-lf-panel">
      <Placeholder icon="terminal" title="Brak otwartych terminali">
        Kliknij <span className="codicon codicon-add align-middle" aria-hidden /> lub naciśnij Ctrl+Shift+`.
      </Placeholder>
    </div>
  );
}

/** Terminal panel (below or beside the editor) with terminal tabs, VS Code style. */
export function BottomPanel() {
  const setVisible = useUiStore((s) => s.setBottomPanelVisible);
  const maximized = useUiStore((s) => s.maximized === "panel");
  const toggleMaximized = useUiStore((s) => s.togglePanelMaximized);
  const position = useUiStore((s) => s.panelPosition);
  const setPosition = useUiStore((s) => s.setPanelPosition);
  const swap = useUiStore((s) => s.swapPanel);
  return (
    <section aria-label="Panel terminala" className="flex h-full flex-col bg-lf-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-lf-border px-4 text-[11px] font-semibold uppercase tracking-wider">
        <span className="border-b border-lf-accent pb-1 pt-1.5 text-lf-fg">Terminal</span>
        <div className="flex items-center gap-0.5">
          <PanelButton icon="add" label="Nowy terminal – profil domyślny (Ctrl+Shift+`)" onClick={() => openTerminal()} />
          <ProfileMenu />
          <PanelButton icon="split-horizontal" label="Podziel terminal" onClick={() => openTerminal({ split: "right" })} />
          <PanelButton icon="trash" label="Zamknij aktywny terminal" onClick={() => closeActiveTerminal()} />
          {isSidePosition(position) ? (
            <PanelButton icon="layout-panel" label={position === "left" ? "Przenieś panel nad edytor" : "Przenieś panel pod edytor"} onClick={() => setPosition(turnedPosition(position))} />
          ) : (
            <PanelButton
              icon={position === "top" ? "layout-sidebar-left" : "layout-sidebar-right"}
              label={position === "top" ? "Przenieś panel obok edytora (po lewej)" : "Przenieś panel obok edytora"}
              onClick={() => setPosition(turnedPosition(position))}
            />
          )}
          <PanelButton icon="arrow-swap" label="Zamień miejscami terminal i edytor" onClick={swap} />
          <PanelButton
            icon={maximized ? "screen-normal" : "screen-full"}
            label={maximized ? "Przywróć edytor (Ctrl+Shift+M)" : "Maksymalizuj panel – ukryj edytor (Ctrl+Shift+M)"}
            onClick={toggleMaximized}
          />
          <PanelButton icon="close" label="Ukryj panel (Ctrl+J)" onClick={() => setVisible(false)} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DockArea
          id="panel"
          components={components}
          tabComponents={tabComponents}
          addDefaultPanels={(api) => {
            if (isTauri() && useUiStore.getState().bottomPanelVisible) addTerminalPanel(api, { dock: "panel" });
          }}
          onEmpty={() => setVisible(false)}
          watermark={EmptyPanel}
        />
      </div>
    </section>
  );
}

function PanelButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
    >
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
