import { Command } from "cmdk";
import { useMemo } from "react";
import { useUiStore } from "../store/ui";
import { allCommands } from "./appCommands";
import { formatKeybinding } from "./keybindings";
import { useResolvedBindings } from "../lib/useKeybindings";

/** Ctrl+Shift+P: searchable list of all commands with their shortcuts. */
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const { bindings, errors } = useResolvedBindings();
  const commands = useMemo(() => allCommands().filter((c) => c.id !== "palette.open"), []);
  const keyFor = (id: string) => {
    const chord = bindings.get(id);
    if (!chord) return null;
    return formatKeybinding([chord.ctrl && "ctrl", chord.shift && "shift", chord.alt && "alt", chord.meta && "meta", chord.key].filter(Boolean).join("+"));
  };

  const run = (id: string) => {
    setOpen(false);
    commands.find((c) => c.id === id)?.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-16" onMouseDown={() => setOpen(false)}>
      <div onMouseDown={(e) => e.stopPropagation()} className="h-fit w-[min(640px,90vw)]">
        <Command
          label="Paleta poleceń"
          loop
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          className="flex max-h-[60vh] flex-col overflow-hidden rounded-md border border-lf-border bg-lf-elevated shadow-2xl"
        >
          <Command.Input
            autoFocus
            placeholder="Wpisz polecenie…"
            className="border-b border-lf-border bg-lf-editor px-3 py-2 text-sm text-lf-fg outline-none placeholder:text-lf-subtle"
          />
          <Command.List className="overflow-auto py-1">
            <Command.Empty className="px-3 py-2 text-xs text-lf-subtle">Brak pasujących poleceń</Command.Empty>
            {commands.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.category}: ${c.title} ${c.id}`}
                onSelect={() => run(c.id)}
                className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[13px] text-lf-fg data-[selected=true]:bg-lf-hover"
              >
                <span className="text-lf-muted">{c.category}:</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {keyFor(c.id) && (
                  <kbd className="rounded border border-lf-border bg-lf-editor px-1.5 font-mono text-[11px] text-lf-muted">{keyFor(c.id)}</kbd>
                )}
              </Command.Item>
            ))}
          </Command.List>
          {errors.length > 0 && (
            <div className="border-t border-lf-border px-3 py-1 text-[11px] text-lf-danger">{errors.join(" · ")}</div>
          )}
        </Command>
      </div>
    </div>
  );
}
