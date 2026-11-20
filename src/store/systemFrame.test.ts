import { describe, expect, it } from "vitest";
import { systemFrame } from "./settings";

describe("systemFrame", () => {
  it("is the system's frame by default on Windows only; the setting wins", () => {
    expect(systemFrame(undefined, true)).toBe(true);
    expect(systemFrame(undefined, false)).toBe(false);
    expect(systemFrame("system", false)).toBe(true);
    expect(systemFrame("custom", true)).toBe(false);
  });
});
