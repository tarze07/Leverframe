import type { DockviewApi } from "dockview-react";

/** `main` = editor/terminal area in the centre, `panel` = bottom panel. */
export type DockId = "main" | "panel";

const docks = new Map<DockId, DockviewApi>();
const listeners = new Set<() => void>();

export const dockRegistry = {
  set(id: DockId, api: DockviewApi | null) {
    if (api) docks.set(id, api);
    else docks.delete(id);
    listeners.forEach((l) => l());
  },
  get: (id: DockId): DockviewApi | undefined => docks.get(id),
  /** Notified when a dock is registered or removed. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
