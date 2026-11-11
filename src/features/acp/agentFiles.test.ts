import { describe, expect, it, vi } from "vitest";
import { serveFsRequest, type FsDeps, type FsRequest } from "./agentFiles";
import type { EditorEntry } from "../../store/editor";

const req = (op: "read" | "write", content: string | null = null): FsRequest => ({ requestId: 1, op, path: "/p/a.ts", inside: true, content });

function deps(editor?: Partial<EditorEntry>) {
  return {
    editorFor: vi.fn<FsDeps["editorFor"]>(() =>
      editor ? ({ path: "/p/a.ts", dirty: true, save: vi.fn(async () => true), ...editor } as EditorEntry) : undefined,
    ),
    readText: vi.fn<FsDeps["readText"]>(async () => ({ content: "z dysku", mtime: 100 })),
    writeText: vi.fn<FsDeps["writeText"]>(async () => 200),
    filesChanged: vi.fn<FsDeps["filesChanged"]>(),
  };
}

describe("serving an agent's file requests", () => {
  it("reads an open editor with its unsaved changes, else the disk", async () => {
    const mtimes = new Map<string, number>();
    expect(await serveFsRequest(req("read"), mtimes, deps({ getText: () => "niezapisane" }))).toEqual({ content: "niezapisane" });
    const d = deps();
    expect(await serveFsRequest(req("read"), mtimes, d)).toEqual({ content: "z dysku" });
    expect(mtimes.get("/p/a.ts")).toBe(100);
    // An editor still loading its file: the disk.
    expect(await serveFsRequest(req("read"), mtimes, deps({ getText: () => null }))).toEqual({ content: "z dysku" });
  });

  it("writes through an open editor (one undoable change, then save)", async () => {
    const applyText = vi.fn(() => true);
    const save = vi.fn(async () => true);
    const d = deps({ applyText, save });
    expect(await serveFsRequest(req("write", "nowe"), new Map(), d)).toEqual({ ok: true });
    expect(applyText).toHaveBeenCalledWith("nowe");
    expect(save).toHaveBeenCalled();
    expect(d.writeText).not.toHaveBeenCalled();
    expect(d.filesChanged).toHaveBeenCalledWith(["/p/a.ts"]);

    const failing = deps({ applyText, save: vi.fn(async () => false) });
    expect(await serveFsRequest(req("write", "x"), new Map(), failing)).toMatchObject({ error: expect.stringContaining("Nie udało się zapisać") });
    expect(failing.filesChanged).not.toHaveBeenCalled();
  });

  it("writes a closed file only if it did not change since the agent read it", async () => {
    const mtimes = new Map([["/p/a.ts", 100]]);
    const d = deps();
    expect(await serveFsRequest(req("write", "nowe"), mtimes, d)).toEqual({ ok: true });
    expect(d.writeText).toHaveBeenCalledWith("/p/a.ts", "nowe", 100);
    expect(mtimes.get("/p/a.ts")).toBe(200);

    const conflict = deps();
    conflict.writeText.mockRejectedValueOnce({ kind: "conflict", message: "zmieniony", mtime: 300 });
    expect(await serveFsRequest(req("write", "x"), new Map([["/p/a.ts", 100]]), conflict)).toMatchObject({
      error: expect.stringContaining("zmienił się na dysku"),
    });
    // Never read: written without a check (a new file).
    const fresh = deps();
    await serveFsRequest(req("write", "x"), new Map(), fresh);
    expect(fresh.writeText).toHaveBeenCalledWith("/p/a.ts", "x", null);
  });

  it("reports read errors", async () => {
    const d = deps();
    d.readText.mockRejectedValueOnce({ kind: "other", message: "Nie można otworzyć pliku" });
    expect(await serveFsRequest(req("read"), new Map(), d)).toEqual({ error: "Nie można otworzyć pliku" });
  });
});
