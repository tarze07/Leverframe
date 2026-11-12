import { beforeEach, describe, expect, it } from "vitest";
import { agentTerminalKey, MAX_TERMINAL_DATA, useAgentTerminalsStore } from "./agentTerminals";

describe("agent terminals store", () => {
  beforeEach(() => useAgentTerminalsStore.setState({ terminals: {} }));

  it("collects a command's output and its end", () => {
    const key = agentTerminalKey("chat-1", "term-1");
    const s = useAgentTerminalsStore.getState();
    s.append(key, "ignored before start");
    s.start(key, "npm test", "/home/me/app");
    s.append(key, "\x1b[32mok\x1b[0m\r\n");
    s.append(key, "done");
    s.exit(key, 3, null);
    expect(useAgentTerminalsStore.getState().terminals[key]).toEqual({
      command: "npm test",
      cwd: "/home/me/app",
      data: "\x1b[32mok\x1b[0m\r\ndone",
      dropped: 0,
      exit: { code: 3, signal: null },
    });
  });

  it("keeps at most MAX_TERMINAL_DATA characters, counting what it drops", () => {
    const key = "c/t";
    const s = useAgentTerminalsStore.getState();
    s.start(key, "yes", null);
    s.append(key, "a".repeat(MAX_TERMINAL_DATA));
    s.append(key, "bcd");
    const t = useAgentTerminalsStore.getState().terminals[key];
    expect(t.data.length).toBe(MAX_TERMINAL_DATA);
    expect(t.data.endsWith("abcd")).toBe(true);
    expect(t.dropped).toBe(3);
  });

  it("forgets the commands of one conversation", () => {
    const s = useAgentTerminalsStore.getState();
    s.start("chat-1/term-1", "a", null);
    s.start("chat-10/term-1", "b", null);
    s.forget("chat-1");
    expect(Object.keys(useAgentTerminalsStore.getState().terminals)).toEqual(["chat-10/term-1"]);
  });
});
