import { useEffect } from "react";
import { useUiStore } from "../store/ui";

/** Global layout shortcuts (VS Code compatible). A full keybinding system arrives in stage 7 (#9). */
export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
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
