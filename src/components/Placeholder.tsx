/** Empty-state block used by views that are implemented in later stages. */
export function Placeholder(props: { icon: string; title: string; children?: React.ReactNode; issue?: number }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-lf-muted">
      <span className={`codicon codicon-${props.icon} text-lf-subtle`} style={{ fontSize: 32 }} aria-hidden />
      <p className="text-sm text-lf-fg">{props.title}</p>
      {props.children && <p className="text-xs leading-relaxed">{props.children}</p>}
      {props.issue && <p className="text-xs text-lf-subtle">Zadanie #{props.issue}</p>}
    </div>
  );
}
