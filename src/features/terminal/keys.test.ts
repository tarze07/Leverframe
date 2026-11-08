import { describe, expect, it } from "vitest";
import { terminalKeyAction } from "./keys";

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}, code = "") => ({
  type: "keydown",
  key: k,
  code: code || `Key${k.toUpperCase()}`,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("terminalKeyAction", () => {
  it("sends plain typing and shell shortcuts to the shell", () => {
    expect(terminalKeyAction(key("a"), false, false)).toBeNull();
    expect(terminalKeyAction(key("c", { ctrl: true }), false, false)).toBeNull(); // SIGINT
    expect(terminalKeyAction(key("r", { ctrl: true }), false, false)).toBeNull(); // reverse search
    expect(terminalKeyAction(key("v", { ctrl: true }), false, false)).toBeNull();
  });

  it("lets app shortcuts bubble out of the terminal", () => {
    expect(terminalKeyAction(key("b", { ctrl: true }), false, false)).toBe("app");
    expect(terminalKeyAction(key("j", { ctrl: true }), false, false)).toBe("app");
    expect(terminalKeyAction(key("p", { ctrl: true }), false, false)).toBe("app");
    expect(terminalKeyAction(key("`", { ctrl: true }, "Backquote"), false, false)).toBe("app");
    expect(terminalKeyAction(key("~", { ctrl: true, shift: true }, "Backquote"), false, false)).toBe("app");
  });

  it("maps copy, paste and find", () => {
    expect(terminalKeyAction(key("C", { ctrl: true, shift: true }), true, false)).toBe("copy");
    expect(terminalKeyAction(key("V", { ctrl: true, shift: true }), false, false)).toBe("paste");
    expect(terminalKeyAction(key("f", { ctrl: true }), false, false)).toBe("find");
  });

  it("uses Windows Terminal conventions on Windows", () => {
    expect(terminalKeyAction(key("c", { ctrl: true }), true, true)).toBe("copy");
    expect(terminalKeyAction(key("c", { ctrl: true }), false, true)).toBeNull(); // still SIGINT without selection
    expect(terminalKeyAction(key("v", { ctrl: true }), false, true)).toBe("paste");
  });

  it("follows the app's keybinding map when given", () => {
    const appShortcut = (e: { key: string; ctrlKey: boolean; shiftKey: boolean }) => e.ctrlKey && !e.shiftKey && e.key === "k";
    expect(terminalKeyAction(key("k", { ctrl: true }), false, false, appShortcut)).toBe("app");
    expect(terminalKeyAction(key("b", { ctrl: true }), false, false, appShortcut)).toBeNull(); // Ctrl+B to the shell again
  });

  it("ignores keyup and Alt combinations", () => {
    expect(terminalKeyAction({ ...key("b", { ctrl: true }), type: "keyup" }, false, false)).toBeNull();
    expect(terminalKeyAction(key("b", { ctrl: true, alt: true }), false, false)).toBeNull();
  });
});
