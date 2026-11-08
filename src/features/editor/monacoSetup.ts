/**
 * Monaco is loaded lazily (only when the first editor opens) and bundled locally: no CDN.
 * Language workers come from the npm package via Vite's `?worker` imports.
 */
import * as monaco from "monaco-editor";
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
/** Light and dark themes matching the app's design tokens. */
export function ensureTheme() {
  if (themed) return;
  themed = true;
  monaco.editor.defineTheme("leverframe-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#23272e",
      "editor.foreground": "#d7dae0",
      "editorLineNumber.foreground": "#5c6370",
      "editorCursor.foreground": "#4d9cf8",
      "editor.selectionBackground": "#3e4451",
      "editorWidget.background": "#2c313a",
      "editorWidget.border": "#2f343d",
    },
  });
  monaco.editor.defineTheme("leverframe-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#24292f",
      "editorLineNumber.foreground": "#8c959f",
      "editorCursor.foreground": "#0969da",
      "editor.selectionBackground": "#c8d7f5",
      "editorWidget.background": "#f3f4f6",
      "editorWidget.border": "#d6d8dd",
    },
  });
}

/** Switches all editors (Monaco themes are global). */
export function applyEditorTheme(mode: "dark" | "light") {
  ensureTheme();
  monaco.editor.setTheme(mode === "light" ? "leverframe-light" : "leverframe-dark");
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
