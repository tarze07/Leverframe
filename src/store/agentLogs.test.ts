import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
const listen = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { useAgentLogsStore } from "./agentLogs";

describe("agent logs store", () => {
  // An unhandled rejection here would fail the whole Vitest run (as it did in CI).
  it("does not raise when live updates are unavailable", async () => {
    listen.mockRejectedValueOnce(new Error("no event system"));
    const stop = useAgentLogsStore.getState().watch();
    await new Promise((r) => setTimeout(r, 10));
    expect(() => stop()).not.toThrow();
  });

  it("stops listening when the view goes away", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    const stop = useAgentLogsStore.getState().watch();
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(unlisten).toHaveBeenCalled();
  });
});
