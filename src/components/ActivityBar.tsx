import { useUiStore } from "../store/ui";
import { isWaiting, useChatsStore } from "../store/chats";
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
  // Conversations waiting for a decision (their tab may be closed).
  const waiting = useChatsStore((s) => (view.id === "chats" ? Object.values(s.chats).filter((c) => isWaiting(c.state)).length : 0));
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
      {waiting > 0 && (
        <span
          className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-lf-accent px-1 text-center text-[10px] font-semibold leading-4 text-lf-accent-fg"
          title={`Rozmowy czekające na decyzję: ${waiting}`}
        >
          {waiting}
        </span>
      )}
    </button>
  );
}
