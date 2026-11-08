import type { ITheme } from "@xterm/xterm";

const css = (name: string, fallback: string): string => {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};

/** xterm.js theme from the app's design tokens plus One Dark / One Light–style ANSI palettes. */
export function terminalTheme(mode: "dark" | "light" = "dark"): ITheme {
  const base = {
    background: css("--lf-editor-bg", mode === "dark" ? "#23272e" : "#ffffff"),
    foreground: css("--lf-fg", mode === "dark" ? "#d7dae0" : "#24292f"),
    cursor: css("--lf-accent", "#4d9cf8"),
    cursorAccent: css("--lf-editor-bg", mode === "dark" ? "#23272e" : "#ffffff"),
  };
  if (mode === "light") {
    return {
      ...base,
      selectionBackground: "#c8d7f5",
      black: "#383a42",
      red: "#c4302b",
      green: "#3f8f2f",
      yellow: "#9a6700",
      blue: "#2b62d6",
      magenta: "#a626a4",
      cyan: "#0e7c86",
      white: "#8a8f98",
      brightBlack: "#5c6370",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#b08800",
      brightBlue: "#4078f2",
      brightMagenta: "#c74ded",
      brightCyan: "#0997b3",
      brightWhite: "#24292f",
    };
  }
  return {
    ...base,
    selectionBackground: "#3e4451",
    black: "#3f4451",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d7dae0",
    brightBlack: "#5c6370",
    brightRed: "#ef7a84",
    brightGreen: "#a5d68a",
    brightYellow: "#f0cd8a",
    brightBlue: "#74bdfa",
    brightMagenta: "#d48fe8",
    brightCyan: "#66c8d4",
    brightWhite: "#ffffff",
  };
}
