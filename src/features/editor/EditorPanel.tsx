import { lazy, Suspense } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";

export interface EditorParams {
  path: string;
  /** 1-based line to reveal after opening. */
  line?: number;
  /** Markdown: text, text + preview, or preview only (kept with the layout). */
  view?: "edit" | "split" | "preview";
}

// Monaco (several MB) is loaded only when the first editor is opened.
const MonacoEditor = lazy(() => import("./MonacoEditor"));

/** Dock panel with a text editor for one file. */
export function EditorPanel(props: IDockviewPanelProps<EditorParams>) {
  if (!isTauri()) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="file-code" title="Edytor działa w aplikacji desktopowej" />
      </div>
    );
  }
  return (
    <Suspense fallback={<p className="p-4 text-xs text-lf-muted">Wczytywanie edytora…</p>}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}
