/** Keyboard decisions for the terminal, kept pure so they can be unit-tested. */

export type TerminalKeyAction = "copy" | "paste" | "find" | "app" | null;

interface KeyLike {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const isWindows = (): boolean => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/**
 * What to do with a key pressed inside the terminal:
 * - `app`: let it bubble to the app's global shortcuts instead of sending it to the shell
 *   (Ctrl+B, Ctrl+J, Ctrl+`, Ctrl+Shift+` – like VS Code's "commandsToSkipShell"),
 * - `copy` / `paste` / `find`: handled by the terminal component,
 * - `null`: normal input for the shell.
 */
export function terminalKeyAction(e: KeyLike, hasSelection: boolean, windows = isWindows()): TerminalKeyAction {
  if (e.type !== "keydown" || e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return null;
  const key = e.key.toLowerCase();

  if (e.code === "Backquote") return "app";
  if (e.shiftKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    return null;
  }
  if (key === "b" || key === "j" || key === "p") return "app";
  if (key === "f") return "find";
  // Windows Terminal convention: Ctrl+C copies when text is selected, Ctrl+V pastes.
  if (windows && key === "c" && hasSelection) return "copy";
  if (windows && key === "v") return "paste";
  return null;
}
