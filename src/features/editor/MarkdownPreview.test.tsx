import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const openUrl = vi.fn(async (url: string) => void url);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
const openFile = vi.fn();
vi.mock("../../workbench/commands", () => ({ openFile: (p: string) => openFile(p) }));
vi.mock("./monacoSetup", () => ({
  monaco: {
    languages: { getLanguages: () => [{ id: "typescript" }] },
    editor: { colorize: async (text: string) => `<span class="mtk1">${text}</span>` },
  },
}));

import { MarkdownPreview } from "./MarkdownPreview";

const SOURCE = `# Leverframe

Zobacz [stronę](https://example.com), [dokumentację](docs/PLAN.md) i [start](#szybki-start).

![zrzut](img/shot.png)
![brak](img/missing.png)

## Szybki start

\`\`\`ts
const a = 1;
\`\`\`
`;

describe("MarkdownPreview", () => {
  beforeEach(() => {
    invoke.mockReset();
    openUrl.mockClear();
    openFile.mockClear();
    URL.createObjectURL = vi.fn(() => "blob:shot");
    URL.revokeObjectURL = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "fs_read_image" && args.path === "/home/me/app/img/shot.png") return new ArrayBuffer(4);
      throw { kind: "other", message: "brak pliku" };
    });
  });

  it("renders the file, loads local images through the backend and highlights code", async () => {
    render(<MarkdownPreview source={SOURCE} path="/home/me/app/README.md" />);
    expect(screen.getByRole("heading", { level: 1, name: "Leverframe" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("id", "szybki-start");
    await waitFor(() => expect(screen.getByAltText("zrzut")).toHaveAttribute("src", "blob:shot"));
    expect(invoke).toHaveBeenCalledWith("fs_read_image", { path: "/home/me/app/img/shot.png" });
    expect(await screen.findByText("[brak obrazu: brak]")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("pre code .mtk1")).not.toBeNull());
  });

  it("never navigates the window: web links open in the browser, files in the editor", () => {
    render(<MarkdownPreview source={SOURCE} path="/home/me/app/README.md" />);
    const web = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("stronę").dispatchEvent(web);
    expect(web.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");

    fireEvent.click(screen.getByText("dokumentację"));
    expect(openFile).toHaveBeenCalledWith("/home/me/app/docs/PLAN.md");

    fireEvent.click(screen.getByText("start"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not run scripts from the file", () => {
    render(<MarkdownPreview source={'<img src="x.png" onerror="window.__pwned=1"><script>window.__pwned=1</script>'} path="/a/b.md" />);
    expect(document.querySelector("[data-testid=markdown-preview] script")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
