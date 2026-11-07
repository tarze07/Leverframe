import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStarter, isAwaitingSecret } from "./agentStart";

describe("isAwaitingSecret", () => {
  it("recognises password, passphrase and host-key prompts", () => {
    expect(isAwaitingSecret("me@srv's password: ")).toBe(true);
    expect(isAwaitingSecret("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")).toBe(true);
    expect(isAwaitingSecret("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")).toBe(true);
    expect(isAwaitingSecret("\x1b[1mPassword:\x1b[0m ")).toBe(true);
  });

  it("does not block on normal prompts", () => {
    expect(isAwaitingSecret("Welcome\r\nme@host:~$ ")).toBe(false);
    expect(isAwaitingSecret("PS C:\\Users\\me> ")).toBe(false);
    expect(isAwaitingSecret("password reset done\r\n$ ")).toBe(false);
  });
});

describe("createAgentStarter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("types the command once the output has been quiet", () => {
    const write = vi.fn();
    const s = createAgentStarter({ command: "claude", write, quietMs: 400 });
    s.onOutput("Last login: today\r\n");
    vi.advanceTimersByTime(200);
    s.onOutput("me@host:~$ ");
    vi.advanceTimersByTime(399);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledWith("claude\r");
    s.onOutput("more");
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("waits while a password is requested and types after login", () => {
    const write = vi.fn();
    const onBlocked = vi.fn();
    const s = createAgentStarter({ command: "codex", write, onBlocked });
    s.onOutput("me@srv's password: ");
    vi.advanceTimersByTime(5000);
    expect(write).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    s.onOutput("\r\nWelcome to srv\r\nme@srv:~$ ");
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledWith("codex\r");
  });

  it("falls back to typing when the shell prints nothing", () => {
    const write = vi.fn();
    createAgentStarter({ command: "kilo", write, fallbackMs: 4000 });
    vi.advanceTimersByTime(4000);
    expect(write).toHaveBeenCalledWith("kilo\r");
  });

  it("can type without pressing Enter", () => {
    const write = vi.fn();
    const s = createAgentStarter({ command: "rm -rf build", write, submit: false });
    s.onOutput("$ ");
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledWith("rm -rf build");
  });

  it("does nothing after dispose", () => {
    const write = vi.fn();
    const s = createAgentStarter({ command: "agy", write });
    s.dispose();
    vi.advanceTimersByTime(10_000);
    expect(write).not.toHaveBeenCalled();
  });
});
