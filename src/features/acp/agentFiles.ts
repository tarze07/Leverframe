import { editorForPath, type EditorEntry } from "../../store/editor";
import { errorMessage, fsClient, isConflict } from "../editor/fsClient";
import { notifyFilesChanged } from "../../lib/fileEvents";

/** A file request of the agent, already mapped to this machine and checked by the backend. */
export interface FsRequest {
  requestId: number;
  op: "read" | "write";
  path: string;
  /** Inside the session folder; otherwise the user is asked first. */
  inside: boolean;
  content: string | null;
}

export type FsReply = { content: string } | { ok: true } | { error: string };

export interface FsDeps {
  editorFor: (path: string) => EditorEntry | undefined;
  readText: (path: string) => Promise<{ content: string; mtime: number }>;
  writeText: (path: string, content: string, expectedMtime: number | null) => Promise<number>;
  filesChanged: (paths: string[]) => void;
}

const defaultDeps: FsDeps = {
  editorFor: editorForPath,
  readText: (p) => fsClient.readText(p),
  writeText: (p, c, m) => fsClient.writeText(p, c, m),
  filesChanged: notifyFilesChanged,
};

/**
 * Serves one file request of an agent.
 * - read: the text of an open editor (unsaved changes included), else the file on disk;
 * - write: an open editor gets the new text as one undoable change and saves it (with its own
 *   conflict check); otherwise the file is written only if it has not changed since the agent
 *   read it (`mtimes` remembers what each session read).
 */
export async function serveFsRequest(req: FsRequest, mtimes: Map<string, number>, deps: FsDeps = defaultDeps): Promise<FsReply> {
  const editor = deps.editorFor(req.path);
  try {
    if (req.op === "read") {
      const open = editor?.getText?.();
      if (open != null) return { content: open };
      const file = await deps.readText(req.path);
      mtimes.set(req.path, file.mtime);
      return { content: file.content };
    }
    const content = req.content ?? "";
    if (editor?.applyText?.(content)) {
      const saved = await editor.save();
      if (!saved) return { error: "Nie udało się zapisać pliku – szczegóły w edytorze (np. plik zmienił się na dysku)." };
    } else {
      const mtime = await deps.writeText(req.path, content, mtimes.get(req.path) ?? null);
      mtimes.set(req.path, mtime);
    }
    deps.filesChanged([req.path]);
    return { ok: true };
  } catch (e) {
    if (isConflict(e)) return { error: "Plik zmienił się na dysku, odkąd agent go przeczytał. Przeczytaj go ponownie." };
    return { error: errorMessage(e) };
  }
}
