import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { isMarkdownPath, useEditorStore, type EditorView } from "../../store/editor";
import { useSettingsStore } from "../../store/settings";
import { useUiStore } from "../../store/ui";
import { baseName, errorMessage, fsClient, isConflict } from "./fsClient";
import { applyEditorTheme, editorThemeName, ensureTheme, languageForPath, monaco } from "./monacoSetup";
import type { EditorParams } from "./EditorPanel";
import { MarkdownPreview } from "./MarkdownPreview";

type Banner = { kind: "conflict" | "error"; message: string } | null;

/** settings.json "autoSave": save shortly after typing stops, or when the editor loses focus. */
export type AutoSave = "off" | "afterDelay" | "onFocusChange";
export const AUTO_SAVE_DELAY_MS = 1000;

function autoSaveSetting(): AutoSave {
  const v = useSettingsStore.getState().values.autoSave;
  return v === "afterDelay" || v === "onFocusChange" ? v : "off";
}

const VIEWS: { view: EditorView; icon: string; label: string }[] = [
  { view: "edit", icon: "edit", label: "Tylko tekst" },
  { view: "split", icon: "split-horizontal", label: "Tekst i podgląd obok (Ctrl+K V)" },
  { view: "preview", icon: "open-preview", label: "Tylko podgląd (Ctrl+Shift+V)" },
];

export default function MonacoEditor({ api, params }: IDockviewPanelProps<EditorParams>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const savedVersion = useRef(0);
  const mtime = useRef<number | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const markdown = isMarkdownPath(params.path);
  const [view, setViewState] = useState<EditorView>(markdown ? (params.view ?? "edit") : "edit");
  const [previewSource, setPreviewSource] = useState("");
  const bannerRef = useRef<Banner>(null);
  useEffect(() => {
    bannerRef.current = banner;
  }, [banner]);
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
      setDirtyState(dirty);
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

    const changeView = (next: EditorView) => {
      setViewState(next);
      api.updateParameters({ ...params, view: next });
      useEditorStore.getState().setView(api.id, next);
      if (next !== "preview") requestAnimationFrame(() => editor.focus());
    };
    setViewRef.current = changeView;
    useEditorStore.getState().register(api.id, {
      path,
      dirty: false,
      save: () => save(),
      ...(markdown ? { setView: changeView, view } : {}),
    });
    if (api.isActive) useEditorStore.getState().setLastActive(api.id);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    if (markdown) {
      const current = () => useEditorStore.getState().editors[api.id]?.view ?? "edit";
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV, () =>
        changeView(current() === "preview" ? "edit" : "preview"),
      );
      editor.addCommand(
        monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyCode.KeyV),
        () => changeView(current() === "split" ? "edit" : "split"),
      );
    }

    // Preview text follows the editor, a little behind fast typing.
    let previewTimer = 0;
    const updatePreview = () => {
      if (!markdown) return;
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => setPreviewSource(editor.getModel()?.getValue() ?? ""), 150);
    };

    let autoSaveTimer = 0;
    const autoSave = () => {
      // Never repeat a save that is waiting for a conflict decision.
      if (bannerRef.current?.kind === "conflict") return;
      const model = editor.getModel();
      if (model && model.getAlternativeVersionId() !== savedVersion.current) void save();
    };
    const changeSub = editor.onDidChangeModelContent(() => {
      markDirty();
      updatePreview();
      clearTimeout(autoSaveTimer);
      if (autoSaveSetting() === "afterDelay") autoSaveTimer = window.setTimeout(autoSave, AUTO_SAVE_DELAY_MS);
    });
    const blurSub = editor.onDidBlurEditorText(() => autoSaveSetting() === "onFocusChange" && autoSave());
    const focusSub = editor.onDidFocusEditorText(() => useEditorStore.getState().setLastActive(api.id));
    // Dockview detaches a hidden tab's DOM without a blur event, so Monaco would still treat this
    // editor as focused and send typing meant for the newly shown file here. Let go of the focus first.
    const releaseFocus = () => {
      if (!editor.hasTextFocus()) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && container.contains(active)) active.blur();
    };
    const visibilitySub = api.onDidVisibilityChange(({ isVisible }) => !isVisible && releaseFocus());
    const activeSub = api.onDidActiveChange(({ isActive }) => {
      if (!isActive) {
        releaseFocus();
        return;
      }
      useEditorStore.getState().setLastActive(api.id);
      if (useEditorStore.getState().editors[api.id]?.view !== "preview") editor.focus();
    });

    fsClient
      .readText(path)
      .then((file) => {
        if (disposed) return;
        const uri = monaco.Uri.file(path);
        monaco.editor.getModel(uri)?.dispose();
        const model = monaco.editor.createModel(file.content, languageForPath(path), uri);
        editor.setModel(model);
        setPreviewSource(file.content);
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
      clearTimeout(previewTimer);
      clearTimeout(autoSaveTimer);
      changeSub.dispose();
      blurSub.dispose();
      focusSub.dispose();
      visibilitySub.dispose();
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
  const setViewRef = useRef<(view: EditorView) => void>(() => undefined);

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
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-lf-border px-2 text-xs" aria-label="Pasek edytora">
        <span className="min-w-0 flex-1 truncate text-[11px] text-lf-subtle" title={path}>
          {path}
        </span>
        {dirty && <span className="shrink-0 text-[11px] text-lf-muted">Niezapisane zmiany</span>}
        <button
          type="button"
          onClick={() => void saveRef.current()}
          disabled={!dirty}
          title="Zapisz (Ctrl+S)"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <span className="codicon codicon-save" aria-hidden />
          Zapisz
        </button>
        {markdown && (
          <div role="group" aria-label="Widok pliku Markdown" className="ml-1 flex shrink-0 items-center rounded border border-lf-border">
            {VIEWS.map((v) => (
              <button
                key={v.view}
                type="button"
                title={v.label}
                aria-label={v.label}
                aria-pressed={view === v.view}
                onClick={() => setViewRef.current(v.view)}
                className={`px-1.5 py-0.5 ${view === v.view ? "bg-lf-hover text-lf-fg" : "text-lf-muted hover:text-lf-fg"}`}
              >
                <span className={`codicon codicon-${v.icon}`} aria-hidden />
              </button>
            ))}
          </div>
        )}
      </div>
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
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          className={`min-w-0 flex-1 ${view === "preview" ? "hidden" : ""}`}
          data-testid="monaco-container"
        />
        {markdown && view !== "edit" && (
          <div className={`min-w-0 flex-1 ${view === "split" ? "border-l border-lf-border" : ""}`}>
            <MarkdownPreview source={previewSource} path={path} />
          </div>
        )}
      </div>
    </div>
  );
}
