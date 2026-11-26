import { useEffect } from "react";
import { useUiStore } from "../store/ui";
import { resolveTheme, themeCssVariables } from "../theme/themes";
import { safeStorage } from "./storage";

const prefersLight = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;

/** Applies theme and fonts as attributes / CSS variables on <html>. "system" follows the OS live. */
export function useAppearance() {
  const theme = useUiStore((s) => s.theme);
  const darkTheme = useUiStore((s) => s.darkTheme);
  const lightTheme = useUiStore((s) => s.lightTheme);
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const setResolved = useUiStore((s) => s.setResolvedTheme);

  useEffect(() => {
    const applyTheme = () => {
      const t = resolveTheme(theme, darkTheme, lightTheme, prefersLight());
      const root = document.documentElement;
      root.dataset.theme = t.kind;
      root.dataset.themeId = t.id;
      const vars = themeCssVariables(t);
      for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
      setResolved(t.kind, t.id);
      // The start screen of index.html uses these colors before the app loads (#115).
      rememberStartColors(vars["--lf-editor-bg"], vars["--lf-fg-muted"]);
    };
    applyTheme();
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [theme, darkTheme, lightTheme, setResolved]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--lf-font-mono", fontMono);
    root.style.setProperty("--lf-font-size-mono", `${fontSize}px`);
  }, [fontMono, fontSize]);
}

/** Key of the colors the start screen (index.html) shows before the app has loaded. */
export const START_COLORS_KEY = "leverframe.startColors";

export function rememberStartColors(bg: string | undefined, fg: string | undefined) {
  if (bg && fg) safeStorage.setItem(START_COLORS_KEY, JSON.stringify({ bg, fg }));
}
