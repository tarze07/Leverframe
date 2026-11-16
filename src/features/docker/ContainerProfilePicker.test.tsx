import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DockerContainer } from "./dockerClient";

const containers: DockerContainer[] = ["sklep-agenci", "baza"].map((name) => ({
  id: `c-${name}`,
  name,
  image: "img",
  state: "running",
  status: "",
  createdAt: "",
  ports: "",
  labels: {},
  leverframe: name === "sklep-agenci",
}));
const info = vi.fn(async () => ({ installed: true, running: true, clientVersion: "", serverVersion: "", serverOs: "linux", message: null as string | null }));
vi.mock("./dockerClient", () => ({ dockerClient: { info: () => info(), containers: async () => containers } }));
const addContainerProfile = vi.fn<(name: string) => Promise<object>>(async () => ({}));
vi.mock("./containerTerminal", () => ({ addContainerProfile: (name: string) => addContainerProfile(name) }));

import { ContainerProfilePicker } from "./ContainerProfilePicker";
import { useProfilesStore } from "../../store/profiles";

describe("ContainerProfilePicker", () => {
  it("adds containers without a profile", async () => {
    useProfilesStore.setState({
      profiles: [{ id: "container:sklep-agenci", name: "sklep-agenci", kind: "container", command: "", args: [], container: { name: "sklep-agenci", autoStart: true }, source: "detected" }],
    });
    const onDone = vi.fn();
    render(<ContainerProfilePicker onDone={onDone} />);
    const list = await screen.findByRole("list", { name: "Kontenery bez profilu" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(within(list).getByText("baza")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("Dodaj"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(addContainerProfile).toHaveBeenCalledWith("baza");
  });

  it("says why it cannot list containers", async () => {
    info.mockResolvedValueOnce({ installed: true, running: false, clientVersion: "", serverVersion: "", serverOs: null as unknown as string, message: "Docker nie działa" });
    render(<ContainerProfilePicker onDone={() => undefined} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Docker nie działa");
  });
});
