import { useEffect, useMemo } from "react";
import { keybindingOverrides, useSettingsStore } from "../store/settings";
import { allCommands, DEFAULT_KEYBINDINGS } from "../workbench/appCommands";
import { matches, resolveBindings, type KeyChord } from "../workbench/keybindings";

let active = new Map<string, KeyChord>();

/** True when the event is bound to an app command (the terminal then lets it bubble). */
export function isAppShortcut(e: Parameters<typeof matches>[1]): boolean {
  for (const chord of active.values()) if (matches(chord, e)) return true;
  return false;
}

/** Bindings in effect and problems in the user's "keybindings" setting. */
export function useResolvedBindings() {
  const values = useSettingsStore((s) => s.values);
  return useMemo(() => resolveBindings(DEFAULT_KEYBINDINGS, keybindingOverrides(values)), [values]);
}

/** Global shortcuts: defaults from DEFAULT_KEYBINDINGS, overridable in settings.json. */
export function useKeybindings() {
  const { bindings } = useResolvedBindings();
  useEffect(() => {
    active = bindings;
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== "keydown" || e.repeat) return;
      for (const [id, chord] of bindings) {
        if (!matches(chord, e)) continue;
        const cmd = allCommands().find((c) => c.id === id);
        if (!cmd) return;
        e.preventDefault();
        e.stopPropagation();
        cmd.run();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}
