import { useEffect, useState } from "react";
import { getAppInfo, type AppInfo } from "../lib/tauri";
import { useUiStore } from "../store/ui";
import { selectActiveTerminal, useTerminalStore } from "../store/terminal";
import { useProfilesStore } from "../store/profiles";
import { toggleTerminalPanel } from "../workbench/commands";

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleBottomPanel = useUiStore((s) => s.toggleBottomPanel);
  const active = useTerminalStore(selectActiveTerminal);
  const profileName = useProfilesStore((s) => s.byId(active?.profileId)?.name);

  useEffect(() => {
    getAppInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-lf-border bg-lf-statusbar px-2 text-xs text-lf-statusbar-fg">
      <div className="flex items-center gap-1">
        <StatusButton
          icon="terminal"
          title="Pokaż / ukryj terminal (Ctrl+`)"
          label={active ? (profileName ?? active.title) : "Brak aktywnego terminala"}
          onClick={toggleTerminalPanel}
        />
      </div>
      <div className="flex items-center gap-1">
        <StatusItem
          icon={info ? "vm" : "globe"}
          label={info ? `${info.os} · ${info.arch} · v${info.version}` : "przeglądarka (bez Tauri)"}
        />
        <StatusButton icon="layout-sidebar-left" title="Panel boczny (Ctrl+B)" onClick={toggleSidebar} />
        <StatusButton icon="layout-panel" title="Panel dolny (Ctrl+J)" onClick={toggleBottomPanel} />
      </div>
    </footer>
  );
}

function StatusItem({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="flex items-center gap-1 px-1.5">
      <span className={`codicon codicon-${icon}`} style={{ fontSize: 14 }} aria-hidden />
      {label}
    </span>
  );
}

function StatusButton(props: { icon: string; title: string; label?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.label ? undefined : props.title}
      onClick={props.onClick}
      className="flex items-center gap-1 rounded px-1.5 hover:bg-lf-hover hover:text-lf-fg"
    >
      <span className={`codicon codicon-${props.icon}`} style={{ fontSize: 14 }} aria-hidden />
      {props.label}
    </button>
  );
}
