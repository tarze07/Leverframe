import { useEffect, useRef } from "react";
import { useUiStore } from "../../store/ui";
import { applyEditorTheme, editorThemeName, ensureTheme, languageForPath, monaco } from "./monacoSetup";

export default function MonacoDiff({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const themeId = useUiStore((s) => s.resolvedThemeId);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureTheme();
    const { fontMono, fontSize, resolvedThemeId } = useUiStore.getState();
    const editor = monaco.editor.createDiffEditor(container, {
      theme: editorThemeName(resolvedThemeId),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: fontMono,
      fontSize,
      scrollBeyondLastLine: false,
    });
    // No URIs: these models must not clash with an open editor of the same file.
    const language = languageForPath(path);
    const original = monaco.editor.createModel(oldText ?? "", language);
    const modified = monaco.editor.createModel(newText, language);
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
    // A change view shows one change for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => applyEditorTheme(themeId), [themeId]);
  useEffect(() => {
    monaco.editor.getDiffEditors().forEach((e) => e.updateOptions({ fontFamily: fontMono, fontSize }));
  }, [fontMono, fontSize]);

  return (
    <div className="flex h-full flex-col bg-lf-editor">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-lf-border px-2 text-[11px] text-lf-subtle">
        <span className="codicon codicon-diff" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </span>
        <span>{oldText == null ? "nowy plik" : "przed ← → po"}</span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" data-testid="monaco-diff" />
    </div>
  );
}
