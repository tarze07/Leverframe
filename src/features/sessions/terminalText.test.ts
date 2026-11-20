import { describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { terminalText } from "./SessionPlayer";

const buffer = (lines: [string, boolean][]) => ({
  buffer: {
    active: {
      length: lines.length,
      getLine: (i: number) => ({ translateToString: () => lines[i][0], isWrapped: lines[i][1] }),
    },
  },
});

describe("terminalText", () => {
  it("joins wrapped lines, trims line ends and drops empty lines at the end (#101)", () => {
    const term = buffer([
      ["$ npm test   ", false],
      ["> sklep@1.0.0 test: a very long line that the terminal wr", false],
      ["apped", true],
      ["PASS  koszyk.test.ts", false],
      ["", false],
      ["   ", false],
    ]);
    expect(terminalText(term as never)).toBe("$ npm test\n> sklep@1.0.0 test: a very long line that the terminal wrapped\nPASS  koszyk.test.ts");
  });
});
