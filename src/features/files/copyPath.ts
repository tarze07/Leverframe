import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAgentsStore } from "../../store/agents";
import { useSettingsStore } from "../../store/settings";
import { baseName } from "../editor/fsClient";
import { isWindows } from "../terminal/keys";

/** What is copied of a file or folder (#121). */
export type PathKind = "absolute" | "relative" | "name";

/** `relativePathSeparator` in settings.json: the system's separator, or always `/`. */
export type SeparatorSetting = "auto" | "/";

const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * `path` relative to `root` (the project folder): with the system's separator (`\` on Windows)
 * or `/`. `.` for the root itself; the absolute path when it is outside the root.
 */
export function relativePath(path: string, root: string | null | undefined, separator: SeparatorSetting = "auto", windows = isWindows()): string {
  if (!root) return path;
  const p = norm(path);
  const r = norm(root);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let rel: string;
  if (same(p, r)) rel = ".";
  else if (same(p.slice(0, r.length + 1), `${r}/`)) rel = p.slice(r.length + 1);
  else return path;
  return windows && separator === "auto" ? rel.replaceAll("/", "\\") : rel;
}

/** The text copied for `kind` of `path`. */
export function pathText(kind: PathKind, path: string, root: string | null | undefined, separator: SeparatorSetting = "auto", windows = isWindows()): string {
  if (kind === "name") return baseName(path);
  if (kind === "relative") return relativePath(path, root, separator, windows);
  return path;
}

export const PATH_LABELS: Record<PathKind, string> = {
  absolute: "Kopiuj ścieżkę",
  relative: "Kopiuj ścieżkę względną",
  name: "Kopiuj nazwę",
};

/** Copies `kind` of `path` (relative to the project folder) to the clipboard; the text copied. */
export async function copyPath(kind: PathKind, path: string): Promise<string> {
  const setting = useSettingsStore.getState().values.relativePathSeparator === "/" ? "/" : "auto";
  const text = pathText(kind, path, useAgentsStore.getState().projectDir, setting);
  await writeText(text);
  return text;
}

/**
 * The copy shortcut of a key press, as in VS Code: Shift+Alt+C – the path, Ctrl (⌘) +Shift+Alt+C
 * – the relative path. `code` is used: Alt changes the character on macOS and some layouts.
 */
export function copyShortcut(e: { code: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): PathKind | null {
  if (e.code !== "KeyC" || !e.shiftKey || !e.altKey) return null;
  return e.ctrlKey || e.metaKey ? "relative" : "absolute";
}
