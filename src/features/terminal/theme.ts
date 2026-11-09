import type { ITheme } from "@xterm/xterm";
import { resolveTheme, themeById, type ThemeDef } from "../../theme/themes";

/** xterm.js theme for an app theme (id, or "dark" / "light" for the defaults). */
export function terminalTheme(themeId: string = "dark"): ITheme {
  const t: ThemeDef = themeById(themeId) ?? resolveTheme(themeId, "dark", "light", false);
  const { tokens: k, ansi: a } = t;
  return {
    background: k.editor,
    foreground: k.fg,
    cursor: k.accent,
    cursorAccent: k.editor,
    selectionBackground: k.selection,
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15],
  };
}
