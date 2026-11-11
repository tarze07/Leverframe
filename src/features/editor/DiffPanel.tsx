import { lazy, Suspense } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { diffStore } from "./diffStore";

export interface DiffParams {
  diffId: string;
  path: string;
}

// Monaco is loaded only when needed (like the editor).
const MonacoDiff = lazy(() => import("./MonacoDiff"));

/** Read-only side-by-side view of a change (e.g. proposed by an agent). */
export function DiffPanel(props: IDockviewPanelProps<DiffParams>) {
  const diff = diffStore.get(props.params.diffId);
  if (!isTauri() || !diff) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="diff" title="Podgląd zmiany nie jest już dostępny">
          Zmiany są pamiętane do zamknięcia aplikacji.
        </Placeholder>
      </div>
    );
  }
  return (
    <Suspense fallback={<p className="p-4 text-xs text-lf-muted">Wczytywanie…</p>}>
      <MonacoDiff path={props.params.path} oldText={diff.oldText} newText={diff.newText} />
    </Suspense>
  );
}
