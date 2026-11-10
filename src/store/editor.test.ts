import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentEditor, isMarkdownPath, saveAllEditors, useEditorStore } from "./editor";

describe("editor registry", () => {
  beforeEach(() => useEditorStore.setState({ editors: {}, lastActive: null }));

  it("finds the editor commands act on", () => {
    const save = vi.fn(async () => true);
    useEditorStore.getState().register("e1", { path: "/a.md", dirty: false, save });
    useEditorStore.getState().register("e2", { path: "/b.ts", dirty: false, save });
    useEditorStore.getState().setLastActive("e2");
    expect(currentEditor("e1")?.[0]).toBe("e1");
    expect(currentEditor("terminal-3")?.[0]).toBe("e2"); // a terminal is active: the last editor
    useEditorStore.getState().unregister("e2");
    expect(currentEditor("terminal-3")).toBeNull();
  });

  it("saves all editors with changes and counts failures", async () => {
    const ok = vi.fn(async () => true);
    const fail = vi.fn(async () => false);
    const clean = vi.fn(async () => true);
    useEditorStore.setState({
      editors: {
        a: { path: "/a", dirty: true, save: ok },
        b: { path: "/b", dirty: true, save: fail },
        c: { path: "/c", dirty: false, save: clean },
      },
    });
    expect(await saveAllEditors()).toBe(1);
    expect(ok).toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
  });

  it("recognises Markdown files", () => {
    expect(isMarkdownPath("/x/README.md")).toBe(true);
    expect(isMarkdownPath("C:\\docs\\Notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/x/readme.txt")).toBe(false);
  });
});
