import { useId, useState } from "react";
import type { AvailableCommand } from "./acpClient";
import { matchingCommands } from "./chatState";

/**
 * Message box: Enter sends, Shift+Enter adds a line. Typing "/" lists the agent's commands
 * (↑/↓ choose, Tab or Enter completes, Esc closes).
 */
export function PromptBox(props: {
  commands: AvailableCommand[];
  disabled: boolean;
  canSend: boolean;
  busy: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const matches = dismissed ? [] : matchingCommands(props.commands, value);
  const active = matches[Math.min(selected, matches.length - 1)];
  // The hint of a completed command, until the user types its input.
  const chosen = /^\/(\S+) $/.exec(value);
  const hint = chosen ? props.commands.find((c) => c.name === chosen[1])?.input?.hint : undefined;

  const complete = (c: AvailableCommand) => {
    setValue(`/${c.name} `);
    setSelected(0);
  };
  const send = () => {
    const text = value.trim();
    if (!text || !props.canSend) return;
    props.onSend(text);
    setValue("");
    setDismissed(false);
  };

  return (
    <div className="relative flex shrink-0 items-end gap-1 border-t border-lf-border p-2">
      {matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Komendy agenta"
          className="absolute bottom-full left-2 right-2 mb-1 max-h-48 overflow-auto rounded border border-lf-border bg-lf-elevated py-0.5 shadow-lg"
        >
          {matches.map((c) => (
            <li
              key={c.name}
              role="option"
              aria-selected={c === active}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the box
                complete(c);
              }}
              className={`flex cursor-pointer items-baseline gap-2 px-2 py-0.5 ${c === active ? "bg-lf-hover" : ""}`}
            >
              <span className="font-mono text-lf-fg">/{c.name}</span>
              <span className="truncate text-[11px] text-lf-muted">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="Wiadomość do agenta"
        aria-autocomplete="list"
        aria-controls={matches.length ? listId : undefined}
        value={value}
        rows={2}
        disabled={props.disabled}
        placeholder={hint ?? props.placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setSelected(0);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (matches.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const i = matches.indexOf(active);
              setSelected((i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if ((e.key === "Tab" || e.key === "Enter") && active && `/${active.name}` !== value) {
              e.preventDefault();
              complete(active);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="min-h-0 flex-1 resize-none rounded border border-lf-border bg-lf-bg px-2 py-1 font-mono text-xs text-lf-fg outline-none focus:border-lf-accent disabled:opacity-50"
      />
      {props.busy ? (
        <button type="button" onClick={props.onStop} className="rounded border border-lf-border px-2 py-1 text-lf-fg hover:bg-lf-hover">
          <span className="codicon codicon-debug-stop align-middle" aria-hidden /> Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={!props.canSend || !value.trim()}
          className="rounded bg-lf-accent px-2 py-1 text-lf-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          Wyślij
        </button>
      )}
    </div>
  );
}
