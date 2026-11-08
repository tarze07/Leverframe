import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const openFile = vi.fn();
vi.mock("../../workbench/commands", () => ({ openFile: (...a: unknown[]) => openFile(...a) }));

import { QuickOpen } from "./QuickOpen";
import { useAgentsStore } from "../../store/agents";
import { useUiStore } from "../../store/ui";

describe("QuickOpen", () => {
  beforeEach(() => {
    invoke.mockReset();
    openFile.mockReset();
    invoke.mockResolvedValue({ files: ["README.md", "src/main.rs", "src/store/sessions.ts", "src/features/sessions/SessionsView.tsx"], truncated: false });
    useAgentsStore.setState({ projectDir: "/home/me/app" });
    useUiStore.setState({ quickOpen: true });
  });

  it("filters fuzzily and opens the selected file with Enter", async () => {
    render(<QuickOpen />);
    expect(await screen.findAllByRole("option")).toHaveLength(4);
    const input = screen.getByLabelText("Nazwa pliku");
    fireEvent.change(input, { target: { value: "sessview" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openFile).toHaveBeenCalledWith("/home/me/app/src/features/sessions/SessionsView.tsx");
    expect(useUiStore.getState().quickOpen).toBe(false);
  });

  it("moves the selection with arrow keys and closes with Escape", async () => {
    render(<QuickOpen />);
    expect(await screen.findAllByRole("option")).toHaveLength(4);
    const input = screen.getByLabelText("Nazwa pliku");
    fireEvent.change(input, { target: { value: "s" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useUiStore.getState().quickOpen).toBe(false);
  });

  it("renders nothing when closed", () => {
    useUiStore.setState({ quickOpen: false });
    const { container } = render(<QuickOpen />);
    expect(container).toBeEmptyDOMElement();
  });
});
