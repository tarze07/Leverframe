import { useUiStore } from "../store/ui";
import { VIEWS, type ViewDef } from "./views";

export function ActivityBar() {
  const top = VIEWS.filter((v) => v.id !== "settings");
  const bottom = VIEWS.filter((v) => v.id === "settings");
  return (
    <nav aria-label="Activity bar" className="flex w-12 shrink-0 flex-col justify-between border-r border-lf-border bg-lf-bg">
      <div className="flex flex-col">{top.map((v) => <ActivityButton key={v.id} view={v} />)}</div>
      <div className="flex flex-col">{bottom.map((v) => <ActivityButton key={v.id} view={v} />)}</div>
    </nav>
  );
}

function ActivityButton({ view }: { view: ViewDef }) {
  const active = useUiStore((s) => s.activeView === view.id && s.sidebarVisible);
  const selectView = useUiStore((s) => s.selectView);
  return (
    <button
      type="button"
      title={view.title}
      aria-label={view.title}
      aria-pressed={active}
      onClick={() => selectView(view.id)}
      className={`relative flex h-12 items-center justify-center text-xl ${
        active ? "text-lf-fg" : "text-lf-subtle hover:text-lf-fg"
      }`}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-lf-accent" aria-hidden />}
      <span className={`codicon codicon-${view.icon}`} style={{ fontSize: 22 }} aria-hidden />
    </button>
  );
}
