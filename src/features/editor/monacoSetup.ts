/**
 * Monaco is loaded lazily (only when the first editor opens) and bundled locally: no CDN.
 * Language workers come from the npm package via Vite's `?worker` imports.
 */
import * as monaco from "monaco-editor";
import { resolveTheme, themeById, THEMES } from "../../theme/themes";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

let themed = false;
/** One editor theme per app theme, built from its design tokens. */
export function ensureTheme() {
  if (themed) return;
  themed = true;
  for (const t of THEMES) {
    const k = t.tokens;
    monaco.editor.defineTheme(editorThemeName(t.id), {
      base: t.kind === "light" ? "vs" : "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": k.editor,
        "editor.foreground": k.fg,
        "editorLineNumber.foreground": k.subtle,
        "editorLineNumber.activeForeground": k.muted,
        "editorCursor.foreground": k.accent,
        "editor.selectionBackground": k.selection,
        "editor.lineHighlightBackground": k.hover + "80",
        "editorWidget.background": k.elevated,
        "editorWidget.border": k.border,
        "minimap.background": k.editor,
        "scrollbarSlider.background": k.elevated + "b0",
      },
    });
  }
}

/** Monaco theme name for an app theme id (unknown ids get the default of their kind). */
export function editorThemeName(themeId: string): string {
  const t = themeById(themeId) ?? resolveTheme(themeId, "dark", "light", false);
  return `leverframe-${t.id}`;
}

/** Switches all editors (Monaco themes are global). */
export function applyEditorTheme(themeId: string) {
  ensureTheme();
  monaco.editor.setTheme(editorThemeName(themeId));
}

/** Monaco language id for a file path (by extension / file name). */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const special: Record<string, string> = { dockerfile: "dockerfile", makefile: "plaintext", ".bashrc": "shell", ".zshrc": "shell" };
  if (special[name]) return special[name];
  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
  const lang = monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.some((f) => f.toLowerCase() === name));
  return lang?.id ?? "plaintext";
}

export { monaco };
