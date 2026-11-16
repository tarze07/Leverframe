import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { JobEvent } from "./dockerClient";

vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
let emit: (e: JobEvent) => void = () => undefined;
const logs = vi.fn(async (_c: string, onEvent: (e: JobEvent) => void) => ((emit = onEvent), 3));
const cancel = vi.fn<(id: number) => Promise<void>>(async () => undefined);
vi.mock("./dockerClient", () => ({ dockerClient: { logs: (c: string, f: (e: JobEvent) => void) => logs(c, f), cancel: (id: number) => cancel(id) } }));

import { ContainerLogsPanel, type ContainerLogsParams } from "./ContainerLogsPanel";
import { parseEnv, suggestedName } from "./NewContainerForm";

describe("ContainerLogsPanel", () => {
  it("follows the logs while open and stops when closed", async () => {
    const view = render(<ContainerLogsPanel {...({ params: { container: "sklep-agenci" } } as unknown as IDockviewPanelProps<ContainerLogsParams>)} />);
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith("sklep-agenci", expect.any(Function)));
    act(() => {
      emit({ type: "line", text: "\x1b[32mserwer gotowy\x1b[0m" });
      emit({ type: "line", text: "GET / 200" });
    });
    expect(screen.getByLabelText("Logi").textContent).toBe("serwer gotowy\nGET / 200");
    expect(screen.getByRole("status")).toHaveTextContent("Na żywo");
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(3);
  });
});

describe("new container form helpers", () => {
  it("suggests a valid name from the folder and reads variables", () => {
    expect(suggestedName("/home/me/Sklep Główny")).toBe("sklep-glowny-agenci");
    expect(suggestedName("C:\\Projekty\\źródła")).toBe("zrodla-agenci");
    expect(suggestedName(null)).toBe("leverframe-agenci");
    expect(suggestedName("/home/me/___")).toBe("leverframe-agenci");
    expect(parseEnv("A=1\n\n B = x=y \nBEZ")).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: " x=y" },
      { name: "BEZ", value: "" },
    ]);
  });
});
