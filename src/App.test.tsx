import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { useUiStore } from "./store/ui";

describe("App layout", () => {
  it("renders activity bar, sidebar, workbench and status bar", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Activity bar" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Terminale" })).toBeInTheDocument();
    expect(screen.getByTestId("workbench-dock")).toBeInTheDocument();
    expect(screen.getByText("przeglądarka (bez Tauri)")).toBeInTheDocument();
  });

  it("switches sidebar view from the activity bar and toggles with Ctrl+B", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agenci" }));
    expect(screen.getByRole("complementary", { name: "Agenci" })).toBeInTheDocument();

    const before = useUiStore.getState().sidebarVisible;
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().sidebarVisible).toBe(!before);
  });
});
