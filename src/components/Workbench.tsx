import { useCallback } from "react";
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { safeStorage } from "../lib/storage";
import { WelcomePanel } from "../features/editor/WelcomePanel";

export const LAYOUT_STORAGE_KEY = "leverframe.workbench.layout";

/** Panel components available in the editor/terminal area. Terminals (#3) and editors (#8) register here. */
const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  welcome: WelcomePanel,
};

function addDefaultPanels(api: DockviewApi) {
  api.addPanel({ id: "welcome", component: "welcome", title: "Witaj" });
}

function restoreLayout(api: DockviewApi): boolean {
  const raw = safeStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) return false;
  try {
    api.fromJSON(JSON.parse(raw));
    return api.panels.length > 0;
  } catch {
    api.clear();
    return false;
  }
}

/** Tabbed, splittable editor/terminal area with drag & drop and persisted layout. */
export function Workbench() {
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const { api } = event;
    if (!restoreLayout(api)) addDefaultPanels(api);
    api.onDidLayoutChange(() => {
      safeStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
    });
  }, []);

  return (
    <div className="h-full w-full" data-testid="workbench-dock">
      <DockviewReact components={components} onReady={onReady} theme={themeDark} />
    </div>
  );
}
