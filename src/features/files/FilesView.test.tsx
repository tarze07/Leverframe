import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
const openFile = vi.fn();
vi.mock("../../workbench/commands", () => ({ openFile: (...a: unknown[]) => openFile(...a) }));

import { FilesView } from "./FilesView";
import { useAgentsStore } from "../../store/agents";
import { useUiStore } from "../../store/ui";

const dirs: Record<string, { name: string; path: string; isDir: boolean }[]> = {
  "/p": [
    { name: "src", path: "/p/src", isDir: true },
    { name: "README.md", path: "/p/README.md", isDir: false },
  ],
  "/p/src": [{ name: "main.rs", path: "/p/src/main.rs", isDir: false }],
};

describe("FilesView", () => {
  beforeEach(() => {
    invoke.mockReset();
    openFile.mockReset();
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir") {
        if (args!.path === "/broken") throw { kind: "other", message: "Folder /broken nie istnieje" };
        return dirs[args!.path!] ?? [];
      }
      if (cmd === "settings_set_project_dir") return (args as { path: string }).path;
      return undefined;
    });
    useAgentsStore.setState({ projectDir: "/p", loaded: true });
  });

  it("shows the tree lazily and opens files", async () => {
    render(<FilesView />);
    const src = await screen.findByRole("treeitem", { name: "src" });
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(invoke).not.toHaveBeenCalledWith("fs_list_dir", { path: "/p/src" });
    fireEvent.click(within(src).getByText("src"));
    expect(await screen.findByText("main.rs")).toBeInTheDocument();
    expect(src).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByText("main.rs"));
    expect(openFile).toHaveBeenCalledWith("/p/src/main.rs");
    fireEvent.click(screen.getByLabelText("Zwiń wszystko"));
    expect(screen.queryByText("main.rs")).toBeNull();
  });

  it("opens quick open and another folder", async () => {
    openDialog.mockResolvedValue("/broken");
    render(<FilesView />);
    await screen.findByText("README.md");
    fireEvent.click(screen.getByLabelText("Szybkie otwieranie (Ctrl+P)"));
    expect(useUiStore.getState().quickOpen).toBe(true);
    fireEvent.click(screen.getByLabelText("Otwórz inny folder…"));
    expect(await screen.findByText("Folder /broken nie istnieje")).toBeInTheDocument();
  });

  it("asks for a folder when none is set", async () => {
    useAgentsStore.setState({ projectDir: null });
    render(<FilesView />);
    expect(screen.getByText("Nie wybrano folderu projektu.")).toBeInTheDocument();
    openDialog.mockResolvedValue("/p");
    fireEvent.click(screen.getByText("Otwórz folder…"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_project_dir", { path: "/p" }));
  });
});
