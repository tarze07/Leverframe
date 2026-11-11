import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inputHeight, MIN_INPUT, PromptBox } from "./PromptBox";

describe("message box height", () => {
  it("grows with the text up to 40% of the panel", () => {
    expect(inputHeight("auto", { content: 20, manual: null, panel: 600 })).toBe(MIN_INPUT);
    expect(inputHeight("auto", { content: 150, manual: null, panel: 600 })).toBe(150);
    expect(inputHeight("auto", { content: 900, manual: null, panel: 600 })).toBe(240);
  });

  it("keeps a dragged height within 80% of the panel, and expands to 70%", () => {
    expect(inputHeight("manual", { content: 0, manual: 300, panel: 600 })).toBe(300);
    expect(inputHeight("manual", { content: 0, manual: 2000, panel: 600 })).toBe(480);
    expect(inputHeight("manual", { content: 0, manual: 5, panel: 600 })).toBe(MIN_INPUT);
    expect(inputHeight("expanded", { content: 0, manual: null, panel: 600 })).toBe(420);
    // A panel not measured yet (0): never below two lines.
    expect(inputHeight("expanded", { content: 0, manual: null, panel: 0 })).toBe(MIN_INPUT);
  });
});

describe("PromptBox", () => {
  const props = { commands: [], disabled: false, canSend: true, busy: false, placeholder: "", onSend: vi.fn(), onStop: vi.fn() };
  const panelHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

  beforeEach(() => {
    localStorage.clear();
    // The panel is 600px tall; a text line is 16px.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.dataset.testid === "panel" ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this instanceof HTMLTextAreaElement ? this.value.split("\n").length * 16 + 8 : 0;
      },
    });
  });
  afterEach(() => {
    if (panelHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", panelHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
  });

  const renderBox = () =>
    render(
      <div data-testid="panel">
        <PromptBox {...props} />
      </div>,
    );
  const box = () => screen.getByLabelText("Wiadomość do agenta");

  it("grows with a long message and shrinks after sending", () => {
    renderBox();
    expect(box().style.height).toBe(`${MIN_INPUT}px`);
    fireEvent.change(box(), { target: { value: Array.from({ length: 10 }, (_, i) => `linia ${i}`).join("\n") } });
    expect(box().style.height).toBe("170px"); // 10 lines + padding + border
    fireEvent.change(box(), { target: { value: Array.from({ length: 40 }, () => "x").join("\n") } });
    expect(box().style.height).toBe("240px"); // 40% of the panel, then it scrolls
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().style.height).toBe(`${MIN_INPUT}px`);
  });

  it("expands to most of the panel and back", () => {
    renderBox();
    const toggle = screen.getByLabelText("Powiększ pole wiadomości");
    fireEvent.click(toggle);
    expect(box().style.height).toBe("420px");
    expect(screen.getByLabelText("Zmniejsz pole wiadomości")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(box(), { target: { value: "długa wiadomość" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().style.height).toBe(`${MIN_INPUT}px`); // sent: back to the usual size
  });

  it("takes a dragged height, remembers it, and goes back to automatic on double click", () => {
    const view = renderBox();
    const handle = screen.getByRole("separator", { name: /Zmień wysokość pola wiadomości/ });
    fireEvent.pointerDown(handle, { button: 0, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 300 });
    fireEvent.pointerUp(handle, { clientY: 300 });
    expect(box().style.height).toBe("244px"); // two lines (jsdom measures 0) + 200px dragged up
    expect(localStorage.getItem("leverframe.chat.inputHeight")).toBe("244");

    view.unmount();
    renderBox();
    expect(box().style.height).toBe("244px"); // remembered in a new conversation

    // Keyboard: ↑ / ↓ by 20px.
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(box().style.height).toBe("264px");
    expect(localStorage.getItem("leverframe.chat.inputHeight")).toBe("264");
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(box().style.height).toBe(`${MIN_INPUT}px`);
    expect(localStorage.getItem("leverframe.chat.inputHeight")).toBeNull();
  });
});
