import { create } from "zustand";

/** Open editors by dock panel id: dirty state and a save function (for "save before closing"). */
interface EditorEntry {
  path: string;
  dirty: boolean;
  save: () => Promise<boolean>;
}

interface EditorStore {
  editors: Record<string, EditorEntry>;
  register: (panelId: string, entry: EditorEntry) => void;
  setDirty: (panelId: string, dirty: boolean) => void;
  unregister: (panelId: string) => void;
}

export const useEditorStore = create<EditorStore>()((set) => ({
  editors: {},
  register: (panelId, entry) => set((s) => ({ editors: { ...s.editors, [panelId]: entry } })),
  setDirty: (panelId, dirty) =>
    set((s) => (s.editors[panelId] ? { editors: { ...s.editors, [panelId]: { ...s.editors[panelId], dirty } } } : s)),
  unregister: (panelId) =>
    set((s) => {
      const editors = { ...s.editors };
      delete editors[panelId];
      return { editors };
    }),
}));

/** Panel id for a file, so opening the same file twice focuses the existing tab. */
export const editorPanelId = (path: string) => `editor:${path}`;
