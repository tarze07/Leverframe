import { useEffect, useState } from "react";
import { getAppInfo, type AppInfo } from "../lib/tauri";
import { useUiStore } from "../store/ui";

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleBottomPanel = useUiStore((s) => s.toggleBottomPanel);

  useEffect(() => {
    getAppInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-lf-border bg-lf-statusbar px-2 text-xs text-lf-statusbar-fg">
      <div className="flex items-center gap-1">
        <StatusItem icon="terminal" label="Brak aktywnego profilu" />
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

function StatusButton({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="rounded px-1.5 hover:bg-lf-hover hover:text-lf-fg">
      <span className={`codicon codicon-${icon}`} style={{ fontSize: 14 }} aria-hidden />
    </button>
  );
}
