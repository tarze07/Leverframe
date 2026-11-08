import { beforeEach, describe, expect, it, vi } from "vitest";

const message = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: (...a: unknown[]) => message(...a) }));

import { confirmCloseEditor } from "./EditorTab";
import { useEditorStore } from "../../store/editor";

describe("confirmCloseEditor", () => {
  const save = vi.fn(async () => true);
  beforeEach(() => {
    message.mockReset();
    save.mockClear();
    useEditorStore.setState({ editors: { e1: { path: "/a.ts", dirty: true, save }, e2: { path: "/b.ts", dirty: false, save } } });
  });

  it("closes clean editors without asking", async () => {
    expect(await confirmCloseEditor("e2")).toBe(true);
    expect(await confirmCloseEditor("unknown")).toBe(true);
    expect(message).not.toHaveBeenCalled();
  });

  it("saves, discards or cancels", async () => {
    message.mockResolvedValueOnce("Zapisz");
    expect(await confirmCloseEditor("e1")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    message.mockResolvedValueOnce("Nie zapisuj");
    expect(await confirmCloseEditor("e1")).toBe(true);
    message.mockResolvedValueOnce("Anuluj");
    expect(await confirmCloseEditor("e1")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the tab open when saving fails", async () => {
    save.mockResolvedValueOnce(false);
    message.mockResolvedValueOnce("Zapisz");
    expect(await confirmCloseEditor("e1")).toBe(false);
  });
});
