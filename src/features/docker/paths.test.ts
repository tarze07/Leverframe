import { describe, expect, it } from "vitest";
import { hostPath } from "./paths";
import type { ContainerMount } from "./dockerClient";

const bind = (source: string, destination: string): ContainerMount => ({ kind: "bind", source, destination, name: null, readWrite: true });
const mounts = [
  bind("/home/me/sklep", "/workspace"),
  bind("/home/me/sklep/vendor", "/opt/vendor"),
  { ...bind("/var/lib/docker/volumes/h/_data", "/root"), kind: "volume" },
];

describe("hostPath", () => {
  it("finds the file of this machine behind a path in the container", () => {
    expect(hostPath(mounts, "/workspace/src/a.ts", null)).toBe("/home/me/sklep/src/a.ts");
    expect(hostPath(mounts, "src/a.ts", "/workspace")).toBe("/home/me/sklep/src/a.ts");
    expect(hostPath(mounts, "../x/../b.ts", "/workspace/src")).toBe("/home/me/sklep/b.ts");
    expect(hostPath(mounts, "/opt/vendor/lib.js", null)).toBe("/home/me/sklep/vendor/lib.js");
    expect(hostPath(mounts, "/workspace", null)).toBe("/home/me/sklep");
  });

  it("knows files that are only in the container", () => {
    expect(hostPath(mounts, "/root/.bashrc", null)).toBeNull(); // a volume
    expect(hostPath(mounts, "/etc/hosts", null)).toBeNull();
    expect(hostPath(mounts, "/workspacex/a", null)).toBeNull();
  });

  it("reads Docker Desktop's sources on Windows", () => {
    const desktop = [bind("/run/desktop/mnt/host/c/Projekty/sklep", "/workspace")];
    expect(hostPath(desktop, "/workspace/src/a.ts", null, true)).toBe("C:\\Projekty\\sklep\\src\\a.ts");
    expect(hostPath([bind("C:\\Projekty\\sklep", "/workspace")], "/workspace/a.ts", null, true)).toBe("C:\\Projekty\\sklep\\a.ts");
  });
});
