import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { dockerClient } from "./dockerClient";

describe("dockerClient", () => {
  beforeEach(() => invoke.mockClear());

  it("calls the read-only Docker commands of the backend", async () => {
    await dockerClient.info();
    await dockerClient.images();
    await dockerClient.containers();
    await dockerClient.volumes();
    await dockerClient.inspect("sklep-agenci");
    expect(invoke.mock.calls).toEqual([
      ["docker_info"],
      ["docker_images"],
      ["docker_containers"],
      ["docker_volumes"],
      ["docker_inspect", { container: "sklep-agenci" }],
    ]);
  });
});
