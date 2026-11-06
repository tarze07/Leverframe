import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const channels: { onmessage: (payload: unknown) => void }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: (payload: unknown) => void;
    constructor(onmessage: (payload: unknown) => void) {
      this.onmessage = onmessage;
      channels.push(this);
    }
  },
}));

import { programTitle, spawnPty, toBytes } from "./ptyClient";

describe("ptyClient", () => {
  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
  });

  it("spawns a pty and wires data/exit channels", async () => {
    invoke.mockResolvedValueOnce({ id: 7, program: "/bin/bash", pid: 42 });
    const onData = vi.fn();
    const onExit = vi.fn();
    const pty = await spawnPty({ cols: 80, rows: 24 }, { onData, onExit });

    expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({ request: { cols: 80, rows: 24 } }));
    expect(pty).toMatchObject({ id: 7, program: "/bin/bash", pid: 42 });

    const [dataChannel, exitChannel] = channels;
    dataChannel.onmessage(new Uint8Array([104, 105]).buffer);
    expect(onData).toHaveBeenCalledWith(new Uint8Array([104, 105]));
    exitChannel.onmessage({ exitCode: 2 });
    expect(onExit).toHaveBeenCalledWith(2);
  });

  it("routes write, resize and kill to the right pty", async () => {
    invoke.mockResolvedValue({ id: 3, program: "pwsh.exe", pid: null });
    const pty = await spawnPty({ cols: 80, rows: 24 }, { onData: vi.fn(), onExit: vi.fn() });
    await pty.write("ls\r");
    await pty.resize(100, 30);
    await pty.kill();
    expect(invoke).toHaveBeenCalledWith("pty_write", { id: 3, data: "ls\r" });
    expect(invoke).toHaveBeenCalledWith("pty_resize", { id: 3, cols: 100, rows: 30 });
    expect(invoke).toHaveBeenCalledWith("pty_kill", { id: 3 });
  });

  it("converts payloads and program names", () => {
    expect(toBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(programTitle("/usr/bin/zsh")).toBe("zsh");
    expect(programTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
    expect(programTitle("bash")).toBe("bash");
  });
});
