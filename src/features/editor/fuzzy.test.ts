import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";
import { baseName, joinPath } from "./fsClient";

const files = [
  "src/components/StatusBar.tsx",
  "src/features/sessions/SessionsView.tsx",
  "src/features/sessions/sessionsClient.ts",
  "src-tauri/src/sessions/service.rs",
  "README.md",
  "src/store/sessions.ts",
];

describe("fuzzy", () => {
  it("requires characters in order", () => {
    expect(fuzzyMatch("stb", "src/components/StatusBar.tsx")).not.toBeNull();
    expect(fuzzyMatch("xsb", "src/components/StatusBar.tsx")).toBeNull();
    expect(fuzzyMatch("", "x")?.score).toBe(0);
  });

  it("ranks file-name and word-boundary matches first", () => {
    expect(fuzzyFilter("sessview", files)[0].path).toBe("src/features/sessions/SessionsView.tsx");
    expect(fuzzyFilter("readme", files)[0].path).toBe("README.md");
    expect(fuzzyFilter("service", files)[0].path).toBe("src-tauri/src/sessions/service.rs");
    expect(fuzzyFilter("sessions.ts", files)[0].path).toBe("src/store/sessions.ts");
  });

  it("returns highlight positions and respects the limit", () => {
    const m = fuzzyMatch("rd", "README.md")!;
    expect(m.positions).toEqual([0, 3]);
    expect(fuzzyFilter("s", files, 2)).toHaveLength(2);
  });
});

describe("paths", () => {
  it("joins and splits Unix and Windows paths", () => {
    expect(joinPath("/home/me/app/", "src/main.rs")).toBe("/home/me/app/src/main.rs");
    expect(joinPath("C:\\work\\app", "src/main.rs")).toBe("C:\\work\\app\\src\\main.rs");
    expect(baseName("C:\\work\\app\\main.rs")).toBe("main.rs");
    expect(baseName("/a/b/")).toBe("b");
  });
});
