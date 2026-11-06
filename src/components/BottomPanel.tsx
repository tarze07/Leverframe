import { useUiStore } from "../store/ui";
import { isTauri } from "../lib/tauri";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { DockArea } from "../workbench/DockArea";
import { addTerminalPanel, closeActiveTerminal, openTerminal } from "../workbench/commands";
import { ProfileMenu } from "../features/profiles/ProfileMenu";
import { Placeholder } from "./Placeholder";

const components = { terminal: TerminalPanel };

function EmptyPanel() {
  return (
    <div className="h-full bg-lf-panel">
      <Placeholder icon="terminal" title="Brak otwartych terminali">
        Kliknij <span className="codicon codicon-add align-middle" aria-hidden /> lub naciśnij Ctrl+Shift+`.
      </Placeholder>
    </div>
  );
}

/** Bottom panel with terminal tabs (VS Code style). */
export function BottomPanel() {
  const setVisible = useUiStore((s) => s.setBottomPanelVisible);
  return (
    <section aria-label="Panel dolny" className="flex h-full flex-col bg-lf-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-lf-border px-4 text-[11px] font-semibold uppercase tracking-wider">
        <span className="border-b border-lf-accent pb-1 pt-1.5 text-lf-fg">Terminal</span>
        <div className="flex items-center gap-0.5">
          <PanelButton icon="add" label="Nowy terminal – profil domyślny (Ctrl+Shift+`)" onClick={() => openTerminal()} />
          <ProfileMenu />
          <PanelButton icon="split-horizontal" label="Podziel terminal" onClick={() => openTerminal({ split: "right" })} />
          <PanelButton icon="trash" label="Zamknij aktywny terminal" onClick={() => closeActiveTerminal()} />
          <PanelButton icon="close" label="Ukryj panel (Ctrl+J)" onClick={() => setVisible(false)} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DockArea
          id="panel"
          components={components}
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
