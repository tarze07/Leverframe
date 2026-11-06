import { useEffect } from "react";
import { useUiStore } from "../store/ui";
import { openTerminal, toggleTerminalPanel } from "../workbench/commands";

/** Global layout shortcuts (VS Code compatible). A full keybinding system arrives in stage 7 (#9). */
export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      if (e.code === "Backquote") {
        e.preventDefault();
        if (e.shiftKey) openTerminal();
        else toggleTerminalPanel();
        return;
      }
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      } else if (key === "j") {
        e.preventDefault();
        useUiStore.getState().toggleBottomPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
