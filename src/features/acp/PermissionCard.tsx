import type { PermissionOption, PermissionToolCall, ToolContent } from "./acpClient";
import { DiffSummary } from "./DiffSummary";

/** The command of a tool call, if its raw input has one (`{ command: "npm test" }` or a word list). */
export function commandOf(rawInput: unknown): string | null {
  if (typeof rawInput === "string") return rawInput;
  if (!rawInput || typeof rawInput !== "object") return null;
  const command = (rawInput as { command?: unknown }).command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((w) => typeof w === "string")) return command.join(" ");
  return null;
}

/**
 * What the agent wants to do and its options. With `shortcuts`, the keys 1–9 choose an option
 * (the panel handles the keys).
 */
export function PermissionCard(props: {
  title: string;
  toolCall: PermissionToolCall;
  options: PermissionOption[];
  shortcuts: boolean;
  toLocal: (path: string) => string | null;
  onChoose: (optionId: string) => void;
}) {
  const command = commandOf(props.toolCall.rawInput);
  const diffs = (props.toolCall.content ?? []).filter((c): c is Extract<ToolContent, { type: "diff" }> => c.type === "diff");
  const files = diffs.length === 0 ? (props.toolCall.locations ?? []).map((l) => l.path) : [];
  return (
    <div role="group" aria-label="Prośba o zgodę" className="mb-2 overflow-hidden rounded border border-lf-accent/60 bg-lf-elevated">
      <p className="px-2 pt-2 text-lf-fg">
        <span className="codicon codicon-shield align-middle text-lf-accent" aria-hidden /> {props.title}
      </p>
      {command && (
        <code className="mx-2 mt-1 block whitespace-pre-wrap break-all rounded bg-lf-bg px-2 py-1 font-mono text-[11px] text-lf-fg">{command}</code>
      )}
      {files.length > 0 && <p className="px-2 pt-1 font-mono text-[11px] text-lf-muted">{files.join(", ")}</p>}
      {diffs.length > 0 && (
        <div className="mt-1">
          {diffs.map((d, i) => (
            <DiffSummary key={`${d.path}:${i}`} path={props.toLocal(d.path) ?? d.path} oldText={d.oldText} newText={d.newText} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1 p-2">
        {props.options.map((o, i) => (
          <button
            key={o.optionId}
            type="button"
            title={[o.kind.endsWith("always") ? "Agent zapamięta tę decyzję" : null, props.shortcuts && i < 9 ? `Klawisz ${i + 1}` : null]
              .filter(Boolean)
              .join(" · ") || undefined}
            onClick={() => props.onChoose(o.optionId)}
            className={`rounded px-2 py-0.5 ${
              o.kind.startsWith("allow") ? "bg-lf-accent text-lf-accent-fg hover:opacity-90" : "border border-lf-border text-lf-fg hover:bg-lf-hover"
            }`}
          >
            {props.shortcuts && i < 9 && <span className="mr-1 opacity-70">{i + 1}</span>}
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
