import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), Channel: class {} }));
vi.mock("../lib/tauri", () => ({ isTauri: () => false }));
const openProfile = vi.fn();
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), openProfile: (...a: unknown[]) => openProfile(...a) }));

import { CommandPalette } from "./CommandPalette";
import { useKeybindings } from "../lib/useKeybindings";
import { useUiStore } from "../store/ui";
import { useProfilesStore } from "../store/profiles";
import { useSettingsStore } from "../store/settings";

function Harness() {
  useKeybindings();
  return <CommandPalette />;
}

describe("command palette and keybindings", () => {
  beforeEach(() => {
    useUiStore.setState({ paletteOpen: false, quickOpen: false, sidebarVisible: true });
    useSettingsStore.setState({ values: {} });
    useProfilesStore.setState({ profiles: [{ id: "wsl:Ubuntu", name: "Ubuntu", kind: "wsl", command: "wsl.exe", args: [], source: "detected" }] });
    openProfile.mockReset();
  });

  it("opens with Ctrl+Shift+P, filters and runs a command", () => {
    render(<Harness />);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "P", ctrlKey: true, shiftKey: true })));
    const input = screen.getByPlaceholderText("Wpisz polecenie…");
    expect(screen.getByText("Pokaż / ukryj panel boczny")).toBeInTheDocument();
    expect(screen.getAllByText("Ctrl+B").length).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: "ubuntu" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openProfile).toHaveBeenCalledWith("wsl:Ubuntu");
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it("uses keybindings from settings.json", () => {
    useSettingsStore.setState({ values: { keybindings: { "view.toggleSidebar": "Ctrl+Alt+S", "files.quickOpen": null } } });
    render(<Harness />);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB", key: "b", ctrlKey: true })));
    expect(useUiStore.getState().sidebarVisible).toBe(true); // default removed by the override
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", key: "s", ctrlKey: true, altKey: true })));
    expect(useUiStore.getState().sidebarVisible).toBe(false);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "p", ctrlKey: true })));
    expect(useUiStore.getState().quickOpen).toBe(false); // disabled with null
  });

  it("closes with Escape and reports invalid keybindings", () => {
    useSettingsStore.setState({ values: { keybindings: { "terminal.new": "Ctrl+Bogus+T" } } });
    useUiStore.setState({ paletteOpen: true });
    render(<Harness />);
    expect(screen.getByText(/nieprawidłowy skrót „Ctrl\+Bogus\+T”/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Wpisz polecenie…"), { key: "Escape" });
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });
});
