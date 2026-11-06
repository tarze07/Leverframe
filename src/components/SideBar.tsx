import type { ComponentType } from "react";
import { useUiStore, type ViewId } from "../store/ui";
import { viewById } from "./views";
import { TerminalsView } from "../features/profiles/TerminalsView";
import { AgentsView } from "../features/agents/AgentsView";
import { SessionsView } from "../features/sessions/SessionsView";
import { FilesView } from "../features/files/FilesView";
import { SettingsView } from "../features/settings/SettingsView";

const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  terminals: TerminalsView,
  agents: AgentsView,
  sessions: SessionsView,
  files: FilesView,
  settings: SettingsView,
};

export function SideBar() {
  const activeView = useUiStore((s) => s.activeView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const def = viewById(activeView);
  const View = VIEW_COMPONENTS[activeView];
  return (
    <aside aria-label={def.title} className="flex h-full flex-col bg-lf-sidebar">
      <div className="flex h-9 shrink-0 items-center justify-between px-4 text-[11px] font-semibold uppercase tracking-wider text-lf-muted">
        <span>{def.title}</span>
        <button
          type="button"
          title="Ukryj panel boczny (Ctrl+B)"
          aria-label="Ukryj panel boczny"
          onClick={toggleSidebar}
          className="rounded p-0.5 hover:bg-lf-hover hover:text-lf-fg"
        >
          <span className="codicon codicon-layout-sidebar-left-off" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <View />
      </div>
    </aside>
  );
}
