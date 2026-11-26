import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
const writeText = vi.fn<(t: string) => Promise<void>>(async () => undefined);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => writeText(t) }));
const openFile = vi.fn();
const closeEditorsUnder = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openFile: (...a: unknown[]) => openFile(...a),
  closeEditorsUnder: (...a: unknown[]) => closeEditorsUnder(...a),
}));

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
    closeEditorsUnder.mockReset();
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "fs_list_dir") {
        if (args!.path === "/broken") throw { kind: "other", message: "Folder /broken nie istnieje" };
        return dirs[args!.path!] ?? [];
      }
      if (cmd === "settings_set_project_dir") return (args as { path: string }).path;
      return undefined;
    });
    useAgentsStore.setState({ projectDir: "/p", recentDirs: [], loaded: true });
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
    fireEvent.click(screen.getByLabelText("Zmień folder projektu"));
    fireEvent.click(screen.getByText("Otwórz folder…"));
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

  it("creates files and folders in the chosen folder and opens a new file (#97)", async () => {
    render(<FilesView />);
    const src = await screen.findByRole("treeitem", { name: "src" });
    // New entries go to the project folder at first, to the last folder clicked then.
    fireEvent.click(screen.getByLabelText("Nowy folder…"));
    const folderForm = screen.getByRole("form", { name: "Nowy folder w p" });
    fireEvent.change(within(folderForm).getByRole("textbox"), { target: { value: "docs" } });
    invoke.mockImplementationOnce(async () => "/p/docs");
    fireEvent.submit(folderForm);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs_create", { parent: "/p", name: "docs", dir: true }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(openFile).not.toHaveBeenCalled();

    fireEvent.click(within(src).getByText("src"));
    fireEvent.click(screen.getByLabelText("Nowy plik…"));
    const fileForm = screen.getByRole("form", { name: "Nowy plik w src" });
    fireEvent.change(within(fileForm).getByRole("textbox"), { target: { value: "lib/nowy.rs" } });
    invoke.mockImplementationOnce(async () => "/p/src/lib/nowy.rs");
    fireEvent.submit(fileForm);
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("/p/src/lib/nowy.rs"));
    expect(invoke).toHaveBeenCalledWith("fs_create", { parent: "/p/src", name: "lib/nowy.rs", dir: false });
    // The folders on the way are opened and read again.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs_list_dir", { path: "/p/src/lib" }));

    // An error stays in the form.
    fireEvent.click(screen.getByLabelText("Nowy plik…"));
    const again = screen.getByRole("form", { name: "Nowy plik w src" });
    fireEvent.change(within(again).getByRole("textbox"), { target: { value: "main.rs" } });
    invoke.mockImplementationOnce(async () => {
      throw { kind: "other", message: "/p/src/main.rs już istnieje" };
    });
    fireEvent.submit(again);
    expect(await screen.findByRole("alert")).toHaveTextContent("już istnieje");
    expect(screen.getByRole("form", { name: "Nowy plik w src" })).toBeInTheDocument();
  });

  it("deletes after asking: to the trash or permanently, and closes its editors (#97)", async () => {
    render(<FilesView />);
    const readme = await screen.findByRole("treeitem", { name: "README.md" });
    fireEvent.click(within(readme).getByLabelText("Usuń README.md"));
    const ask = screen.getByRole("group", { name: "Usuwanie README.md" });
    expect(ask).toHaveTextContent("Usunąć README.md?");
    fireEvent.click(within(ask).getByText("Anuluj"));
    expect(screen.queryByRole("group", { name: "Usuwanie README.md" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("fs_delete", expect.anything());

    fireEvent.click(within(readme).getByLabelText("Usuń README.md"));
    fireEvent.click(screen.getByText("Do kosza"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs_delete", { path: "/p/README.md", permanently: false }));
    await waitFor(() => expect(closeEditorsUnder).toHaveBeenCalledWith("/p/README.md"));

    const src = screen.getByRole("treeitem", { name: "src" });
    fireEvent.click(within(src).getByLabelText("Usuń src"));
    expect(screen.getByRole("group", { name: "Usuwanie src" })).toHaveTextContent("Usunąć folder src z zawartością?");
    fireEvent.click(screen.getByText("Usuń na stałe"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs_delete", { path: "/p/src", permanently: true }));
  });

  it("switches the project folder from the folder menu: a dialog or a recent folder", async () => {
    useAgentsStore.setState({ recentDirs: ["/p", "/home/me/sklep", "/home/me/blog"] });
    render(<FilesView />);
    await screen.findByText("README.md");
    const menu = screen.getByLabelText("Zmień folder projektu");
    expect(menu).toHaveTextContent("p");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    const recent = screen.getByRole("list", { name: "Ostatnio otwierane foldery" });
    // The folder open now is not offered again.
    expect(within(recent).queryByTitle("/p")).toBeNull();
    fireEvent.click(within(recent).getByTitle("/home/me/sklep"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_project_dir", { path: "/home/me/sklep" }));
    await waitFor(() => expect(useAgentsStore.getState().projectDir).toBe("/home/me/sklep"));
    expect(screen.queryByRole("list", { name: "Ostatnio otwierane foldery" })).toBeNull();
  });

  it("offers recent folders when none is open", async () => {
    useAgentsStore.setState({ projectDir: null, recentDirs: ["/home/me/blog"] });
    render(<FilesView />);
    fireEvent.click(within(screen.getByRole("list", { name: "Ostatnio otwierane foldery" })).getByText("blog"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_set_project_dir", { path: "/home/me/blog" }));
  });

  it("copies the path, the relative path and the name from the menu and with shortcuts (#121)", async () => {
    writeText.mockClear();
    render(<FilesView />);
    const src = await screen.findByRole("treeitem", { name: "src" });
    fireEvent.click(within(src).getByText("src"));
    const main = await screen.findByRole("treeitem", { name: "main.rs" });

    fireEvent.contextMenu(within(main).getByText("main.rs"));
    const menu = screen.getByRole("menu", { name: "Plik main.rs" });
    expect(within(menu).queryByText("Nowy plik tutaj…")).toBeNull();
    fireEvent.click(within(menu).getByText("Kopiuj ścieżkę względną"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src/main.rs"));
    expect(await screen.findByRole("status")).toHaveTextContent("Skopiowano: src/main.rs");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(within(main).getByLabelText("Więcej: main.rs"));
    fireEvent.click(screen.getByText("Kopiuj nazwę"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("main.rs"));

    // Shift+Alt+C on the entry: the path; with Ctrl: the relative one.
    const button = within(main).getByText("main.rs").closest("button")!;
    fireEvent.keyDown(button, { code: "KeyC", key: "Ç", shiftKey: true, altKey: true });
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/p/src/main.rs"));
    fireEvent.keyDown(button, { code: "KeyC", key: "C", shiftKey: true, altKey: true, ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src/main.rs"));

    // A folder: also new entries in it; and the project folder itself.
    fireEvent.contextMenu(within(src).getAllByText("src")[0]);
    const folder = screen.getByRole("menu", { name: "Folder src" });
    fireEvent.click(within(folder).getByText("Nowy plik tutaj…"));
    expect(screen.getByRole("form", { name: "Nowy plik w src" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Zmień folder projektu"));
    fireEvent.click(screen.getByText("Kopiuj ścieżkę folderu projektu"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/p"));
  });

  it("says when the clipboard refuses (#121)", async () => {
    writeText.mockRejectedValueOnce("brak dostępu");
    render(<FilesView />);
    const readme = await screen.findByRole("treeitem", { name: "README.md" });
    fireEvent.click(within(readme).getByLabelText("Więcej: README.md"));
    fireEvent.click(screen.getByText("Kopiuj ścieżkę"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nie można skopiować do schowka: brak dostępu");
  });
});
