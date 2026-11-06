import { useCallback, useEffect } from "react";
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from "dockview-react";
import { safeStorage } from "../lib/storage";
import { dockRegistry, type DockId } from "./docks";

export interface DockAreaProps {
  id: DockId;
  components: Record<string, React.FunctionComponent<IDockviewPanelProps>>;
  /** Called when there is no saved layout (or it could not be restored). */
  addDefaultPanels?: (api: DockviewApi) => void;
  /** Called after the last panel is closed. */
  onEmpty?: () => void;
  watermark?: React.FunctionComponent<IWatermarkPanelProps>;
}

export const layoutStorageKey = (id: DockId) => `leverframe.dock.${id}`;

function restoreLayout(api: DockviewApi, key: string): boolean {
  const raw = safeStorage.getItem(key);
  if (!raw) return false;
  try {
    api.fromJSON(JSON.parse(raw));
    return true;
  } catch {
    api.clear();
    return false;
  }
}

/** A tabbed, splittable dock (dockview) with persisted layout, registered under `id`. */
export function DockArea({ id, components, addDefaultPanels, onEmpty, watermark }: DockAreaProps) {
  const onReady = useCallback(
    ({ api }: DockviewReadyEvent) => {
      const key = layoutStorageKey(id);
      if (!restoreLayout(api, key)) addDefaultPanels?.(api);
      api.onDidLayoutChange(() => safeStorage.setItem(key, JSON.stringify(api.toJSON())));
      api.onDidRemovePanel(() => {
        if (api.panels.length === 0) onEmpty?.();
      });
      dockRegistry.set(id, api);
    },
    // Dock configuration is static for the dock's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => dockRegistry.set(id, null), [id]);

  return (
    <div className="h-full w-full" data-testid={`dock-${id}`}>
      <DockviewReact components={components} onReady={onReady} theme={themeDark} watermarkComponent={watermark} />
    </div>
  );
}
