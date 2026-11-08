import { useEffect } from "react";
import { useUiStore } from "../store/ui";

const prefersLight = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;

/** Applies theme and fonts as attributes / CSS variables on <html>. "system" follows the OS live. */
export function useAppearance() {
  const theme = useUiStore((s) => s.theme);
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const setResolved = useUiStore((s) => s.setResolvedTheme);

  useEffect(() => {
    const applyTheme = () => {
      const resolved = theme === "system" ? (prefersLight() ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
      setResolved(resolved);
    };
    applyTheme();
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [theme, setResolved]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--lf-font-mono", fontMono);
    root.style.setProperty("--lf-font-size-mono", `${fontSize}px`);
  }, [fontMono, fontSize]);
}
