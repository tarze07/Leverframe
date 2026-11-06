import type { ITheme } from "@xterm/xterm";

const css = (name: string, fallback: string): string => {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};

/** xterm.js theme built from the app's design tokens plus a One Dark–style ANSI palette. */
export function terminalTheme(): ITheme {
  return {
    background: css("--lf-editor-bg", "#23272e"),
    foreground: css("--lf-fg", "#d7dae0"),
    cursor: css("--lf-accent", "#4d9cf8"),
    cursorAccent: css("--lf-editor-bg", "#23272e"),
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
