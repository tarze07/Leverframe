import { useId, useLayoutEffect, useRef, useState } from "react";
import type { AvailableCommand } from "./acpClient";
import { matchingCommands } from "./chatState";
import { safeStorage } from "../../lib/storage";

/** Height of the message box (px). */
export const MIN_INPUT = 44; // two lines
const STORAGE_KEY = "leverframe.chat.inputHeight";

export type InputSize = "auto" | "manual" | "expanded";

/**
 * Height of the message box: `auto` follows the text up to 40% of the panel, `manual` is what
 * the user dragged (up to 80%), `expanded` takes 70% of the panel.
 */
export function inputHeight(size: InputSize, o: { content: number; manual: number | null; panel: number }): number {
  const cap = (max: number, h: number) => Math.round(Math.min(Math.max(h, MIN_INPUT), Math.max(MIN_INPUT, max)));
  switch (size) {
    case "expanded":
      return cap(o.panel * 0.7, o.panel * 0.7);
    case "manual":
      return cap(o.panel * 0.8, o.manual ?? MIN_INPUT);
    case "auto":
      return cap(o.panel * 0.4, o.content);
  }
}

function savedHeight(): number | null {
  const n = Number(safeStorage.getItem(STORAGE_KEY));
  return Number.isFinite(n) && n >= MIN_INPUT ? n : null;
}

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
  // Size: grows with the text, or the height the user dragged (remembered), or expanded.
  const [manual, setManual] = useState<number | null>(savedHeight);
  const [expanded, setExpanded] = useState(false);
  const size: InputSize = expanded ? "expanded" : manual !== null ? "manual" : "auto";
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const ta = box.current;
    if (!ta) return;
    const panel = root.current?.parentElement?.clientHeight ?? 0;
    ta.style.height = "auto"; // to measure the text
    ta.style.height = `${inputHeight(size, { content: ta.scrollHeight + 2, manual, panel })}px`;
  }, [value, size, manual]);

  const resizeBy = (start: number, delta: number): number => {
    const panel = root.current?.parentElement?.clientHeight ?? 0;
    const h = inputHeight("manual", { content: 0, manual: start + delta, panel });
    setExpanded(false);
    setManual(h);
    return h;
  };
  const remember = (h: number | null) => {
    if (h === null) safeStorage.removeItem(STORAGE_KEY);
    else safeStorage.setItem(STORAGE_KEY, String(h));
  };

  /** Dragging the handle up makes the box taller. */
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const ta = box.current;
    if (!ta || e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.offsetHeight || manual || MIN_INPUT;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    let last: number | null = null;
    const move = (ev: PointerEvent) => {
      last = resizeBy(startH, startY - ev.clientY);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (last !== null) remember(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
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
    setExpanded(false); // back to the usual size; a dragged height stays
  };

  return (
    <div ref={root} className="relative flex shrink-0 items-end gap-1 border-t border-lf-border p-2">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Zmień wysokość pola wiadomości (przeciągnij; dwuklik – automatycznie)"
        title="Przeciągnij, aby zmienić wysokość pola · dwuklik – automatyczna"
        tabIndex={0}
        onPointerDown={onDragStart}
        onDoubleClick={() => {
          setExpanded(false);
          setManual(null);
          remember(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const h = box.current?.offsetHeight || manual || MIN_INPUT;
          const next = inputHeight("manual", {
            content: 0,
            manual: h + (e.key === "ArrowUp" ? 20 : -20),
            panel: root.current?.parentElement?.clientHeight ?? 0,
          });
          setExpanded(false);
          setManual(next);
          remember(next);
        }}
        className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize outline-none hover:bg-lf-accent/30 focus-visible:bg-lf-accent/40"
      />
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
        ref={box}
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
        className="min-h-0 flex-1 resize-none overflow-y-auto rounded border border-lf-border bg-lf-bg px-2 py-1 font-mono text-xs text-lf-fg outline-none focus:border-lf-accent disabled:opacity-50"
      />
      <button
        type="button"
        aria-pressed={expanded}
        title={expanded ? "Zmniejsz pole wiadomości" : "Powiększ pole wiadomości"}
        aria-label={expanded ? "Zmniejsz pole wiadomości" : "Powiększ pole wiadomości"}
        onClick={() => {
          setExpanded((v) => !v);
          box.current?.focus();
        }}
        className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
      >
        <span className={`codicon codicon-${expanded ? "screen-normal" : "screen-full"}`} aria-hidden />
      </button>
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
