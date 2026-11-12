import { create } from "zustand";

/** How a Markdown file is shown: text only, text with the preview beside it, or the preview only. */
export type EditorView = "edit" | "split" | "preview";

/** Open editors by dock panel id: dirty state, save, and the Markdown view switch. */
export interface EditorEntry {
  path: string;
  dirty: boolean;
  save: () => Promise<boolean>;
  /** Markdown files only. */
  setView?: (view: EditorView) => void;
  view?: EditorView;
  /** Current text, unsaved changes included (`null` while the file is still loading). */
  getText?: () => string | null;
  /** Replaces the whole text as one change the user can undo (Ctrl+Z); false if not loaded. */
  applyText?: (text: string) => boolean;
  /** Reads the file again from disk (after a change by someone else), as one undoable change. */
  reload?: () => Promise<void>;
}

interface EditorStore {
  editors: Record<string, EditorEntry>;
  /** Editor that had the focus last (commands act on it when a terminal is focused). */
  lastActive: string | null;
  register: (panelId: string, entry: EditorEntry) => void;
  setDirty: (panelId: string, dirty: boolean) => void;
  setView: (panelId: string, view: EditorView) => void;
  setLastActive: (panelId: string) => void;
  unregister: (panelId: string) => void;
}

export const useEditorStore = create<EditorStore>()((set) => ({
  editors: {},
  lastActive: null,
  register: (panelId, entry) => set((s) => ({ editors: { ...s.editors, [panelId]: entry } })),
  setDirty: (panelId, dirty) =>
    set((s) => (s.editors[panelId] ? { editors: { ...s.editors, [panelId]: { ...s.editors[panelId], dirty } } } : s)),
  setView: (panelId, view) =>
    set((s) => (s.editors[panelId] ? { editors: { ...s.editors, [panelId]: { ...s.editors[panelId], view } } } : s)),
  setLastActive: (lastActive) => set({ lastActive }),
  unregister: (panelId) =>
    set((s) => {
      const editors = { ...s.editors };
      delete editors[panelId];
      return { editors, lastActive: s.lastActive === panelId ? null : s.lastActive };
    }),
}));

/** Panel id for a file, so opening the same file twice focuses the existing tab. */
export const editorPanelId = (path: string) => `editor:${path}`;

/** True for files the Markdown preview can show. */
export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx|mkd)$/i.test(path);

/** The editor commands act on: the active tab of the editor area, else the last focused editor. */
export function currentEditor(activePanelId: string | null | undefined): [string, EditorEntry] | null {
  const { editors, lastActive } = useEditorStore.getState();
  for (const id of [activePanelId, lastActive]) if (id && editors[id]) return [id, editors[id]];
  return null;
}

/** Saves every editor with unsaved changes; returns how many could not be saved. */
export async function saveAllEditors(): Promise<number> {
  const dirty = Object.values(useEditorStore.getState().editors).filter((e) => e.dirty);
  const results = await Promise.all(dirty.map((e) => e.save().catch(() => false)));
  return results.filter((ok) => !ok).length;
}

/** Same file? Windows paths ignore case and the kind of slash. */
export function samePath(a: string, b: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(a) || a.startsWith("\\\\");
  if (!windows) return a === b;
  const norm = (p: string) => p.replaceAll("/", "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** The open editor of a file, if any. */
export function editorForPath(path: string): EditorEntry | undefined {
  return Object.values(useEditorStore.getState().editors).find((e) => samePath(e.path, path));
}
