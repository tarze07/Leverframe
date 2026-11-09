import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useEditorStore } from "../../store/editor";
import { useSettingsStore } from "../../store/settings";
import { useUiStore } from "../../store/ui";
import { baseName, errorMessage, fsClient, isConflict } from "./fsClient";
import { applyEditorTheme, editorThemeName, ensureTheme, languageForPath, monaco } from "./monacoSetup";
import type { EditorParams } from "./EditorPanel";

type Banner = { kind: "conflict" | "error"; message: string } | null;

export default function MonacoEditor({ api, params }: IDockviewPanelProps<EditorParams>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const savedVersion = useRef(0);
  const mtime = useRef<number | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const path = params.path;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureTheme();
    const { fontMono, fontSize } = useUiStore.getState();
    const editor = monaco.editor.create(container, {
      theme: editorThemeName(useUiStore.getState().resolvedThemeId),
      automaticLayout: true,
      fontFamily: fontMono,
      fontSize,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      model: null,
    });
    editorRef.current = editor;
    let disposed = false;
    const title = baseName(path);

    const markDirty = () => {
      const model = editor.getModel();
      const dirty = !!model && model.getAlternativeVersionId() !== savedVersion.current;
      api.setTitle(dirty ? `● ${title}` : title);
      useEditorStore.getState().setDirty(api.id, dirty);
    };

    const save = async (force = false): Promise<boolean> => {
      const model = editor.getModel();
      if (!model) return false;
      try {
        const version = model.getAlternativeVersionId();
        mtime.current = await fsClient.writeText(path, model.getValue(), force ? null : mtime.current);
        savedVersion.current = version;
        setBanner(null);
        markDirty();
        // Editing settings.json in the editor applies the settings on save.
        if (path === useSettingsStore.getState().path) void useSettingsStore.getState().load();
        return true;
      } catch (e) {
        setBanner({ kind: isConflict(e) ? "conflict" : "error", message: errorMessage(e) });
        return false;
      }
    };
    saveRef.current = save;
    reloadRef.current = async () => {
      const file = await fsClient.readText(path);
      const model = editor.getModel();
      if (!model) return;
      model.setValue(file.content);
      mtime.current = file.mtime;
      savedVersion.current = model.getAlternativeVersionId();
      setBanner(null);
      markDirty();
    };

    useEditorStore.getState().register(api.id, { path, dirty: false, save: () => save() });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    const changeSub = editor.onDidChangeModelContent(markDirty);
    const activeSub = api.onDidActiveChange(({ isActive }) => isActive && editor.focus());

    fsClient
      .readText(path)
      .then((file) => {
        if (disposed) return;
        const uri = monaco.Uri.file(path);
        monaco.editor.getModel(uri)?.dispose();
        const model = monaco.editor.createModel(file.content, languageForPath(path), uri);
        editor.setModel(model);
        mtime.current = file.mtime;
        savedVersion.current = model.getAlternativeVersionId();
        if (params.line) {
          editor.revealLineInCenter(params.line);
          editor.setPosition({ lineNumber: params.line, column: 1 });
        }
        if (api.isActive) editor.focus();
      })
      .catch((e: unknown) => !disposed && setLoadError(errorMessage(e)));

    return () => {
      disposed = true;
      changeSub.dispose();
      activeSub.dispose();
      useEditorStore.getState().unregister(api.id);
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // The panel shows one file for its whole lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRef = useRef<(force?: boolean) => Promise<boolean>>(async () => false);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily: fontMono, fontSize });
  }, [fontMono, fontSize]);

  const themeId = useUiStore((s) => s.resolvedThemeId);
  useEffect(() => applyEditorTheme(themeId), [themeId]);

  if (loadError) {
    return <p className="m-4 rounded bg-lf-elevated p-3 text-xs text-lf-danger">{loadError}</p>;
  }

  return (
    <div className="flex h-full flex-col bg-lf-editor">
      {banner && (
        <div role="alert" className="flex items-center gap-2 border-b border-lf-border bg-lf-elevated px-3 py-1.5 text-xs">
          <span className={`codicon codicon-${banner.kind === "conflict" ? "warning" : "error"} text-lf-danger`} aria-hidden />
          <span className="min-w-0 flex-1 text-lf-fg">{banner.message}</span>
          {banner.kind === "conflict" && (
            <>
              <button type="button" onClick={() => void saveRef.current(true)} className="rounded px-2 py-0.5 text-lf-accent hover:bg-lf-hover">
                Nadpisz
              </button>
              <button type="button" onClick={() => void reloadRef.current()} className="rounded px-2 py-0.5 text-lf-muted hover:bg-lf-hover">
                Wczytaj z dysku
              </button>
            </>
          )}
          <button type="button" aria-label="Zamknij komunikat" onClick={() => setBanner(null)} className="rounded p-0.5 text-lf-muted hover:text-lf-fg">
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1" data-testid="monaco-container" />
    </div>
  );
}
