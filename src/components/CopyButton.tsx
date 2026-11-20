import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Copies `text()` to the clipboard; says "Skopiowano" for a moment (or why it failed).
 * `text` is called on click, so long texts are built only when needed.
 */
export function CopyButton({ label, text, showLabel = false, className = "" }: { label: string; text: () => string; showLabel?: boolean; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | { error: string }>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), state === "done" ? 1500 : 4000);
    return () => clearTimeout(t);
  }, [state]);

  const done = state === "done";
  const error = typeof state === "object" ? state.error : null;
  return (
    <button
      type="button"
      title={error ?? (done ? "Skopiowano" : label)}
      aria-label={label}
      onClick={(e) => {
        // Inside a <summary> the click must not open or close the details.
        e.preventDefault();
        e.stopPropagation();
        void writeText(text()).then(
          () => setState("done"),
          (err: unknown) => setState({ error: `Nie można skopiować: ${String(err)}` }),
        );
      }}
      className={`flex shrink-0 items-center gap-1 rounded p-0.5 hover:bg-lf-hover ${error ? "text-lf-danger" : done ? "text-lf-accent" : "text-lf-muted hover:text-lf-fg"} ${className}`}
    >
      <span className={`codicon codicon-${error ? "error" : done ? "check" : "copy"}`} aria-hidden />
      {(showLabel || done || error) && (
        <span role="status" className="text-[11px]">
          {error ? "Błąd schowka" : done ? "Skopiowano" : label}
        </span>
      )}
    </button>
  );
}
