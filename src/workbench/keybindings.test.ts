import { describe, expect, it } from "vitest";
import { eventKey, formatKeybinding, matches, parseKeybinding, resolveBindings } from "./keybindings";

const ev = (code: string, key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  code,
  key,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe("keybindings", () => {
  it("parses chords with aliases and special keys", () => {
    expect(parseKeybinding("Ctrl+Shift+P")).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "p" });
    expect(parseKeybinding("cmd+k")?.meta).toBe(true);
    expect(parseKeybinding("Ctrl+`")?.key).toBe("`");
    expect(parseKeybinding("Ctrl++")?.key).toBe("+");
    expect(parseKeybinding("F5")?.key).toBe("f5");
    expect(parseKeybinding("")).toBeNull();
    expect(parseKeybinding("Ctrl+Foo+P")).toBeNull();
  });

  it("matches physical keys regardless of layout", () => {
    const chord = parseKeybinding("Ctrl+Shift+`")!;
    expect(matches(chord, ev("Backquote", "~", { ctrl: true, shift: true }))).toBe(true);
    expect(matches(chord, ev("Backquote", "`", { ctrl: true }))).toBe(false);
    expect(matches(parseKeybinding("Ctrl+Z")!, ev("KeyZ", "y", { ctrl: true }))).toBe(true); // QWERTZ layout
    expect(eventKey({ code: "", key: "Enter" })).toBe("enter");
  });

  it("formats for display", () => {
    expect(formatKeybinding("ctrl+shift+p")).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("ctrl+`")).toBe("Ctrl+`");
  });

  it("applies user overrides and reports invalid ones", () => {
    const { bindings, errors } = resolveBindings(
      { "palette.open": "Ctrl+Shift+P", "files.quickOpen": "Ctrl+P", "view.togglePanel": "Ctrl+J" },
      { "palette.open": "Ctrl+K", "files.quickOpen": null, "view.togglePanel": "Ctrl+Nope+J" },
    );
    expect(bindings.get("palette.open")?.key).toBe("k");
    expect(bindings.has("files.quickOpen")).toBe(false);
    expect(bindings.get("view.togglePanel")?.key).toBe("j"); // invalid override keeps the default
    expect(errors).toHaveLength(1);
  });
});
