import type { PlanEntry } from "./acpClient";

const ICONS: Record<PlanEntry["status"], { icon: string; className: string; label: string }> = {
  pending: { icon: "circle-large-outline", className: "text-lf-subtle", label: "do zrobienia" },
  in_progress: { icon: "loading codicon-modifier-spin", className: "text-lf-accent", label: "w toku" },
  completed: { icon: "pass-filled", className: "text-lf-muted", label: "zrobione" },
};

/** The agent's plan for this turn; the agent sends it whole on every change. */
export function PlanView({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div role="group" aria-label="Plan agenta" className="mb-2 rounded border border-lf-border px-2 py-1">
      <p className="mb-1 text-[11px] font-semibold text-lf-muted">
        Plan · {done}/{entries.length}
      </p>
      <ol className="flex flex-col gap-0.5">
        {entries.map((e, i) => {
          const s = ICONS[e.status] ?? ICONS.pending;
          return (
            <li key={i} className="flex items-start gap-1.5" aria-label={`${e.content}: ${s.label}`}>
              <span className={`codicon codicon-${s.icon} mt-0.5 ${s.className}`} aria-hidden />
              <span className={e.status === "completed" ? "text-lf-muted line-through" : "text-lf-fg"}>{e.content}</span>
              {e.priority === "high" && e.status !== "completed" && <span className="text-[10px] text-lf-subtle">ważne</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
