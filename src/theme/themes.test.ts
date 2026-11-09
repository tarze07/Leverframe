import { describe, expect, it } from "vitest";
import { resolveTheme, themeById, themeCssVariables, THEMES } from "./themes";
import { terminalTheme } from "../features/terminal/theme";

const HEX = /^#[0-9a-f]{6}$/;

describe("themes", () => {
  it("has several dark and light themes with unique ids", () => {
    expect(THEMES.filter((t) => t.kind === "dark").length).toBeGreaterThanOrEqual(5);
    expect(THEMES.filter((t) => t.kind === "light").length).toBeGreaterThanOrEqual(5);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it("defines every color as a hex value, including 16 ANSI colors", () => {
    for (const t of THEMES) {
      for (const [key, value] of Object.entries(t.tokens)) expect(value, `${t.id}.${key}`).toMatch(HEX);
      expect(t.ansi).toHaveLength(16);
      for (const c of t.ansi) expect(c, t.id).toMatch(HEX);
      // ids must pass the settings.json validation in the backend
      expect(t.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
  });

  it("keeps text readable on the editor background", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const t of THEMES) {
      expect(contrast(t.tokens.fg, t.tokens.editor), `${t.id} fg`).toBeGreaterThanOrEqual(7);
      expect(contrast(t.tokens.muted, t.tokens.sidebar), `${t.id} muted`).toBeGreaterThanOrEqual(4.5);
      // button labels on the accent color; no worse than the original default theme (2.83)
      expect(contrast(t.tokens.accentFg, t.tokens.accent), `${t.id} accent`).toBeGreaterThanOrEqual(2.8);
    }
  });

  it("resolves explicit themes, system mode and unknown ids", () => {
    expect(resolveTheme("dark-plum", "dark", "light", true).id).toBe("dark-plum");
    expect(resolveTheme("system", "dark-forest", "light-paper", false).id).toBe("dark-forest");
    expect(resolveTheme("system", "dark-forest", "light-paper", true).id).toBe("light-paper");
    // a preference of the wrong kind or an unknown id falls back to the default of that kind
    expect(resolveTheme("system", "light-mint", "nope", false).id).toBe("dark");
    expect(resolveTheme("system", "dark", "nope", true).id).toBe("light");
    expect(resolveTheme("light-removed", "dark", "light", false).id).toBe("light");
    expect(resolveTheme("whatever", "dark", "light", true).id).toBe("dark");
  });

  it("maps a theme to CSS variables and a terminal palette", () => {
    const t = themeById("light-paper")!;
    expect(themeCssVariables(t)["--lf-editor-bg"]).toBe(t.tokens.editor);
    const term = terminalTheme("light-paper");
    expect(term.background).toBe(t.tokens.editor);
    expect(term.red).toBe(t.ansi[1]);
    expect(term.brightWhite).toBe(t.ansi[15]);
    expect(terminalTheme("unknown").background).toBe(themeById("dark")!.tokens.editor);
  });
});
