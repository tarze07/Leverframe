import { useEffect } from "react";
import { useUiStore } from "../store/ui";

/** Applies appearance settings (mono font, size) as CSS variables on <html>. */
export function useAppearance() {
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    root.style.setProperty("--lf-font-mono", fontMono);
    root.style.setProperty("--lf-font-size-mono", `${fontSize}px`);
  }, [fontMono, fontSize]);
}
