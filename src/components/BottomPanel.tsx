import { useUiStore } from "../store/ui";
import { Placeholder } from "./Placeholder";

export function BottomPanel() {
  const toggle = useUiStore((s) => s.toggleBottomPanel);
  return (
    <section aria-label="Panel dolny" className="flex h-full flex-col bg-lf-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-lf-border px-4 text-[11px] font-semibold uppercase tracking-wider">
        <span className="border-b border-lf-accent pb-1 pt-1.5 text-lf-fg">Terminal</span>
        <button
          type="button"
          title="Zamknij panel (Ctrl+J)"
          aria-label="Zamknij panel"
          onClick={toggle}
          className="rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
        >
          <span className="codicon codicon-close" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Placeholder icon="terminal" title="Terminal" issue={3}>
          Terminal lokalny pojawi się w etapie 1.
        </Placeholder>
      </div>
    </section>
  );
}
