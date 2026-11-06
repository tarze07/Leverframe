import { isTauri, windowControls } from "../lib/tauri";

/** Frameless-window title bar: drag region + window controls (only inside Tauri). */
export function TitleBar() {
  const native = isTauri();
  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-lf-border bg-lf-bg text-lf-muted"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3">
        <span className="codicon codicon-terminal text-lf-accent" aria-hidden />
        <span data-tauri-drag-region className="text-xs font-semibold tracking-wide text-lf-fg">
          Leverframe
        </span>
      </div>
      <div data-tauri-drag-region className="flex-1 text-center text-xs" />
      {native && (
        <div className="flex h-full">
          <WindowButton label="Minimalizuj" icon="chrome-minimize" onClick={windowControls.minimize} />
          <WindowButton label="Maksymalizuj" icon="chrome-maximize" onClick={windowControls.toggleMaximize} />
          <WindowButton label="Zamknij" icon="chrome-close" onClick={windowControls.close} danger />
        </div>
      )}
    </header>
  );
}

function WindowButton(props: { label: string; icon: string; onClick: () => unknown; danger?: boolean }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={() => void props.onClick()}
      className={`flex w-11 items-center justify-center text-lf-muted hover:text-lf-fg ${
        props.danger ? "hover:bg-lf-danger hover:text-white" : "hover:bg-lf-hover"
      }`}
    >
      <span className={`codicon codicon-${props.icon}`} aria-hidden />
    </button>
  );
}
