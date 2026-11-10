import { describe, expect, it } from "vitest";
import { codeLanguage, dirName, isExternalLink, renderMarkdown, resolveLocalPath } from "./markdown";

describe("renderMarkdown", () => {
  it("renders GitHub-flavoured Markdown", () => {
    const html = renderMarkdown("# Tytuł\n\n- [x] gotowe\n- [ ] do zrobienia\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~stare~~ `kod`\n");
    expect(html).toContain("<h1>Tytuł</h1>");
    expect(html).toContain('<li class="task">☑ gotowe</li>');
    expect(html).toContain('<li class="task">☐ do zrobienia</li>');
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<del>stare</del>");
    expect(html).toContain("<code>kod</code>");
  });

  it("keeps fenced code language for highlighting", () => {
    expect(renderMarkdown("```ts\nconst a = 1;\n```")).toContain('<code class="language-ts">const a = 1;');
  });

  it("removes scripts, event handlers, javascript: links and embedded content", () => {
    const html = renderMarkdown(
      [
        "<script>alert(1)</script>",
        '<img src="x.png" onerror="alert(2)">',
        "[klik](javascript:alert(3))",
        '<a href="javascript:alert(4)">a</a>',
        '<iframe src="https://example.com"></iframe>',
        '<p style="position:fixed">styl</p>',
        '<form action="https://x"><input name="p"></form>',
        "<svg><script>alert(5)</script></svg>",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe|style=|<form|<input/i);
    expect(html).toContain('<img src="x.png">');
    expect(html).toContain("styl");
  });
});

describe("paths in the preview", () => {
  it("resolves relative links and images against the file's folder", () => {
    expect(resolveLocalPath("/home/me/app/docs", "img/shot.png")).toBe("/home/me/app/docs/img/shot.png");
    expect(resolveLocalPath("/home/me/app/docs", "./a.md#sekcja")).toBe("/home/me/app/docs/a.md");
    expect(resolveLocalPath("/home/me/app/docs", "../README.md?raw=1")).toBe("/home/me/app/README.md");
    expect(resolveLocalPath("/home/me/app", "zrzut%20ekranu.png")).toBe("/home/me/app/zrzut ekranu.png");
    expect(resolveLocalPath("/home/me", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveLocalPath("/a", "../../../x")).toBe("/x");
  });

  it("handles Windows and WSL paths", () => {
    expect(resolveLocalPath("C:\\src\\app\\docs", "../img/a.png")).toBe("C:\\src\\app\\img\\a.png");
    expect(resolveLocalPath("C:\\src", "../../../x.png")).toBe("C:\\x.png");
    expect(resolveLocalPath("\\\\wsl.localhost\\Ubuntu\\home\\me", "a/b.png")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\a\\b.png");
    expect(resolveLocalPath("\\\\wsl.localhost\\Ubuntu\\home", "../../../x")).toBe("\\\\wsl.localhost\\Ubuntu\\x");
    expect(resolveLocalPath("/home/me", "D:\\docs\\a.png")).toBe("D:\\docs\\a.png");
  });

  it("leaves web links, data and anchors alone", () => {
    for (const href of ["https://example.com/a.png", "mailto:a@b.c", "data:image/png;base64,AAA", "#sekcja", ""]) {
      expect(resolveLocalPath("/home/me", href)).toBeNull();
    }
    expect(isExternalLink("https://x")).toBe(true);
    expect(isExternalLink("HTTP://x")).toBe(true);
    expect(isExternalLink("mailto:a@b.c")).toBe(true);
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
  });

  it("gives the folder of a file and code languages", () => {
    expect(dirName("/home/me/README.md")).toBe("/home/me");
    expect(dirName("C:\\src\\README.md")).toBe("C:\\src");
    expect(codeLanguage("TS")).toBe("typescript");
    expect(codeLanguage("bash")).toBe("shell");
    expect(codeLanguage("go")).toBe("go");
  });
});
