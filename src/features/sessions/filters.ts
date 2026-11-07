import type { DateRange } from "./sessionsClient";

export const RANGES: { value: DateRange; label: string }[] = [
  { value: "all", label: "Cały czas" },
  { value: "today", label: "Dzisiaj" },
  { value: "7d", label: "Ostatnie 7 dni" },
  { value: "30d", label: "Ostatnie 30 dni" },
];

export const selectClass =
  "min-w-0 flex-1 rounded border border-lf-border bg-lf-editor px-1 py-0.5 text-[11px] text-lf-fg outline-none focus:border-lf-accent";
