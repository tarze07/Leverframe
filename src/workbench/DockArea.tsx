import { useCallback, useEffect } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from "dockview-react";
import { safeStorage } from "../lib/storage";
import { dockRegistry, type DockId } from "./docks";
import { useUiStore } from "../store/ui";

export interface DockAreaProps {
  id: DockId;
  components: Record<string, React.FunctionComponent<IDockviewPanelProps>>;
  tabComponents?: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>>;
  /** Called when there is no saved layout (or it could not be restored). */
  addDefaultPanels?: (api: DockviewApi) => void;
  /** Called after the last panel is closed. */
  onEmpty?: () => void;
  watermark?: React.FunctionComponent<IWatermarkPanelProps>;
  /** Buttons at the right end of each group's tab bar. */
  rightHeaderActions?: React.FunctionComponent<IDockviewHeaderActionsProps>;
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
export function DockArea({ id, components, tabComponents, addDefaultPanels, onEmpty, watermark, rightHeaderActions }: DockAreaProps) {
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
  const resolvedTheme = useUiStore((s) => s.resolvedTheme);

  return (
    <div className="h-full w-full" data-testid={`dock-${id}`}>
      <DockviewReact
        components={components}
        tabComponents={tabComponents}
        onReady={onReady}
        theme={resolvedTheme === "light" ? themeLight : themeDark}
        watermarkComponent={watermark}
        rightHeaderActionsComponent={rightHeaderActions}
      />
    </div>
  );
}
