import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { RemoteDirPicker } from "./RemoteDirPicker";

const tree: Record<string, string[]> = {
  "/home/me": ["projekty", "notatki"],
  "/home/me/projekty": ["sklep"],
  "/home/me/projekty/sklep": [],
  "/home": ["me"],
  "/srv/app": ["src"],
};
const parent = (p: string) => (p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/");

describe("RemoteDirPicker (#100)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, a: { path?: string; parent?: string; name?: string; showHidden?: boolean }) => {
      if (cmd === "remote_make_dir") {
        const path = `${a.parent}/${a.name}`;
        tree[path] = [];
        return { path, parent: a.parent, dirs: [], truncated: false };
      }
      const path = a.path === "" || a.path === "~" ? "/home/me" : a.path!;
      if (!tree[path]) throw `Na srv nie ma folderu ${path}`;
      const dirs = a.showHidden ? [...tree[path], ".config"] : tree[path];
      return { path, parent: parent(path), dirs, truncated: false };
    });
  });

  it("starts at home, goes into folders and up, and gives the chosen path", async () => {
    const onChoose = vi.fn();
    render(<RemoteDirPicker profileId="ssh-config:srv" host="srv" onChoose={onChoose} onCancel={() => undefined} />);
    const list = await screen.findByRole("list", { name: "Foldery" });
    expect(invoke).toHaveBeenCalledWith("remote_list_dirs", { profileId: "ssh-config:srv", path: "", showHidden: false });
    await within(list).findByText("projekty");
    expect(screen.getByLabelText("Ścieżka")).toHaveValue("/home/me");

    fireEvent.click(within(list).getByText("projekty"));
    fireEvent.click(await within(list).findByText("sklep"));
    expect(await within(list).findByText("(brak podfolderów)")).toBeInTheDocument();
    expect(screen.getByLabelText("Ścieżka")).toHaveValue("/home/me/projekty/sklep");
    fireEvent.click(screen.getByLabelText("W górę"));
    await within(list).findByText("sklep");
    fireEvent.click(within(list).getByText("sklep"));
    await within(list).findByText("(brak podfolderów)");
    fireEvent.click(screen.getByText("Wybierz ten folder"));
    expect(onChoose).toHaveBeenCalledWith("/home/me/projekty/sklep");
  });

  it("opens a typed path, shows errors and hidden folders, makes a folder", async () => {
    render(<RemoteDirPicker profileId="p" host="srv" start="/srv/app" onChoose={() => undefined} onCancel={() => undefined} />);
    const list = await screen.findByRole("list", { name: "Foldery" });
    await within(list).findByText("src");

    fireEvent.change(screen.getByLabelText("Ścieżka"), { target: { value: "/brak" } });
    fireEvent.click(screen.getByText("Przejdź"));
    expect(await screen.findByRole("alert")).toHaveTextContent("nie ma folderu /brak");
    // The last folder stays.
    expect(within(list).getByText("src")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Ukryte foldery"));
    expect(await within(list).findByText(".config")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Nowy folder…"));
    fireEvent.change(screen.getByLabelText("Nazwa nowego folderu"), { target: { value: "nowy" } });
    fireEvent.click(screen.getByText("Utwórz"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_make_dir", { profileId: "p", parent: "/srv/app", name: "nowy" }));
    await waitFor(() => expect(screen.getByLabelText("Ścieżka")).toHaveValue("/srv/app/nowy"));
  });

  it("works inside another form without submitting it (forms cannot nest)", async () => {
    const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={submit}>
        <RemoteDirPicker profileId="p" host="srv" onChoose={() => undefined} onCancel={() => undefined} />
      </form>,
    );
    await within(await screen.findByRole("list", { name: "Foldery" })).findByText("projekty");
    expect(document.querySelectorAll("form form")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Ścieżka"), { target: { value: "/srv/app" } });
    fireEvent.keyDown(screen.getByLabelText("Ścieżka"), { key: "Enter" });
    fireEvent.click(screen.getByText("Przejdź"));
    await waitFor(() => expect(screen.getByLabelText("Ścieżka")).toHaveValue("/srv/app"));
    expect(submit).not.toHaveBeenCalled();
  });
});
