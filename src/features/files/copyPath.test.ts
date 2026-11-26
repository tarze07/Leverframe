import { describe, expect, it } from "vitest";
import { copyShortcut, pathText, relativePath } from "./copyPath";

describe("copied paths (#121)", () => {
  it("gives the path relative to the project folder with the chosen separator", () => {
    expect(relativePath("/home/jan/sklep/src/app.ts", "/home/jan/sklep", "auto", false)).toBe("src/app.ts");
    expect(relativePath("/home/jan/sklep/src/app.ts", "/home/jan/sklep/", "/", false)).toBe("src/app.ts");
    expect(relativePath("/home/jan/sklep", "/home/jan/sklep", "auto", false)).toBe(".");
    // Outside the project (or a folder whose name only starts the same): the path as it is.
    expect(relativePath("/home/jan/sklepik/a.ts", "/home/jan/sklep", "auto", false)).toBe("/home/jan/sklepik/a.ts");
    expect(relativePath("/etc/hosts", null, "auto", false)).toBe("/etc/hosts");
    // Windows: case and slashes do not matter; `\\` by default, `/` when chosen.
    expect(relativePath("C:\\Users\\Jan\\Sklep\\src\\app.ts", "c:\\users\\jan\\sklep", "auto", true)).toBe("src\\app.ts");
    expect(relativePath("C:\\Users\\Jan\\Sklep\\src\\app.ts", "C:/Users/Jan/Sklep", "/", true)).toBe("src/app.ts");
  });

  it("gives the path, the relative path or the name", () => {
    const p = "/home/jan/sklep/src/app.ts";
    expect(pathText("absolute", p, "/home/jan/sklep", "auto", false)).toBe(p);
    expect(pathText("relative", p, "/home/jan/sklep", "auto", false)).toBe("src/app.ts");
    expect(pathText("name", p, "/home/jan/sklep", "auto", false)).toBe("app.ts");
    expect(pathText("name", "C:\\x\\Dokumenty\\", null, "auto", true)).toBe("Dokumenty");
  });

  it("knows the shortcuts of VS Code", () => {
    const key = (o: Partial<KeyboardEvent>) => ({ code: "KeyC", shiftKey: true, altKey: true, ctrlKey: false, metaKey: false, ...o });
    expect(copyShortcut(key({}))).toBe("absolute");
    expect(copyShortcut(key({ ctrlKey: true }))).toBe("relative");
    expect(copyShortcut(key({ metaKey: true }))).toBe("relative");
    expect(copyShortcut(key({ altKey: false }))).toBeNull();
    expect(copyShortcut(key({ code: "KeyV" }))).toBeNull();
  });
});
