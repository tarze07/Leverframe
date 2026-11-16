import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerSpec, CreatePlan, DockerContainer, DockerImage, DockerInfo, JobEvent } from "./dockerClient";

vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const pickFolder = vi.fn(async () => "/home/me/projekty/Sklep Główny" as string | null);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => pickFolder() }));
const openContainerLogs = vi.fn();
const openContainerTerminal = vi.fn<(...a: unknown[]) => Promise<string>>(async () => "terminal-1");
const addContainerProfile = vi.fn<(...a: unknown[]) => Promise<object>>(async () => ({}));
vi.mock("./containerTerminal", () => ({
  openContainerTerminal: (...a: unknown[]) => openContainerTerminal(...a),
  addContainerProfile: (...a: unknown[]) => addContainerProfile(...a),
}));
vi.mock("../../workbench/commands", () => ({ openContainerLogs: (...a: unknown[]) => openContainerLogs(...a) }));

const running: DockerInfo = { installed: true, running: true, clientVersion: "29.1.0", serverVersion: "29.1.0", serverOs: "linux", message: null };
const image = (repository: string | null, tag: string | null, leverframe = false): DockerImage => ({
  id: `id-${repository}`,
  repository,
  tag,
  size: "1.2GB",
  createdAt: "",
  createdSince: "2 days ago",
  leverframe,
});
const container = (name: string, state: string): DockerContainer => ({
  id: `c-${name}`,
  name,
  image: "leverframe-agents:0.8.0",
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (0)",
  createdAt: "",
  ports: "",
  labels: {},
  leverframe: name === "sklep-agenci",
});
let emit: (e: JobEvent) => void = () => undefined;
const client = {
  info: vi.fn(async () => running),
  images: vi.fn(async () => [image("leverframe-agents", "0.8.0", true), image("node", "22")]),
  containers: vi.fn(async () => [container("sklep-agenci", "running"), container("baza", "exited")]),
  volumes: vi.fn(async () => [
    { name: "leverframe-sklep-agenci-home", driver: "local", labels: {}, leverframe: true },
    { name: "pgdata", driver: "local", labels: {}, leverframe: false },
  ]),
  containerAction: vi.fn(async () => undefined),
  removeContainer: vi.fn(async () => undefined),
  removeImage: vi.fn(async () => undefined),
  removeVolume: vi.fn(async () => undefined),
  pruneImages: vi.fn(async () => "Total reclaimed space: 1.2GB"),
  pull: vi.fn(async (_image: string, onEvent: (e: JobEvent) => void) => ((emit = onEvent), 7)),
  build: vi.fn(async (_d: string, _t: string, onEvent: (e: JobEvent) => void) => ((emit = onEvent), 8)),
  agentsImage: vi.fn(async () => "leverframe-agents:0.8.0"),
  buildAgentsImage: vi.fn(async (onEvent: (e: JobEvent) => void) => ((emit = onEvent), 9)),
  cancel: vi.fn(async () => undefined),
  createPlan: vi.fn(async (spec: ContainerSpec): Promise<CreatePlan> => ({
    args: [],
    command: `docker run -d --name ${spec.name} ${spec.image} sleep infinity`,
    volume: spec.homeVolume ? `leverframe-${spec.name}-home` : null,
    warnings: [],
  })),
  create: vi.fn(async () => "new-id"),
};
vi.mock("./dockerClient", async (original) => ({
  ...(await original<typeof import("./dockerClient")>()),
  // Read when used: the mock factory runs before `client` is defined.
  get dockerClient() {
    return client;
  },
}));

import { ContainersView } from "./ContainersView";
import { useDockerStore } from "../../store/docker";
import { useAgentsStore } from "../../store/agents";

const row = (name: RegExp | string) => screen.findByRole("listitem", { name });

describe("ContainersView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDockerStore.setState({ info: null, images: [], containers: [], volumes: [], agentsImage: null, status: "idle", error: null, busy: {}, jobs: [] });
    useAgentsStore.setState({ projectDir: "/home/me/sklep" });
  });

  it("says why Docker cannot be used", async () => {
    client.info.mockResolvedValueOnce({ ...running, running: false, serverVersion: null, message: "Docker nie działa – uruchom Docker Desktop" });
    render(<ContainersView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Docker nie działa");
    expect(screen.queryByRole("list", { name: "Obrazy" })).toBeNull();
    expect(client.images).not.toHaveBeenCalled();
  });

  it("lists images, containers and Leverframe's volumes and manages containers", async () => {
    render(<ContainersView />);
    expect(await screen.findByText("Docker 29.1.0 (linux)")).toBeInTheDocument();
    const agents = await row("Obraz leverframe-agents:0.8.0");
    expect(within(agents).getByText("agenci")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Wolumen leverframe-sklep-agenci-home" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: "Wolumen pgdata" })).toBeNull();

    const sklep = await row("Kontener sklep-agenci");
    expect(sklep).toHaveTextContent("działa");
    fireEvent.click(within(sklep).getByLabelText("Zatrzymaj sklep-agenci"));
    await waitFor(() => expect(client.containerAction).toHaveBeenCalledWith("sklep-agenci", "stop"));
    fireEvent.click(within(sklep).getByLabelText("Uruchom ponownie sklep-agenci"));
    await waitFor(() => expect(client.containerAction).toHaveBeenCalledWith("sklep-agenci", "restart"));
    fireEvent.click(within(sklep).getByLabelText("Logi sklep-agenci"));
    expect(openContainerLogs).toHaveBeenCalledWith("sklep-agenci");
    fireEvent.click(within(sklep).getByLabelText("Terminal w sklep-agenci"));
    expect(openContainerTerminal).toHaveBeenCalledWith("sklep-agenci", { leverframe: true, projectDir: "/home/me/sklep" });
    expect(within(sklep).queryByLabelText("Dodaj sklep-agenci jako profil")).toBeNull(); // detected profile

    const baza = await row("Kontener baza");
    expect(baza).toHaveTextContent("zatrzymany");
    fireEvent.click(within(baza).getByLabelText("Dodaj baza jako profil"));
    expect(addContainerProfile).toHaveBeenCalledWith("baza");
    fireEvent.click(within(baza).getByLabelText("Uruchom baza"));
    await waitFor(() => expect(client.containerAction).toHaveBeenCalledWith("baza", "start"));

    // Removing asks first; a running container is stopped and removed (force).
    fireEvent.click(within(await row("Kontener sklep-agenci")).getByLabelText("Usuń kontener sklep-agenci"));
    expect(client.removeContainer).not.toHaveBeenCalled();
    expect(screen.getByText(/działa. Zatrzymać go i usunąć/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Usuń"));
    await waitFor(() => expect(client.removeContainer).toHaveBeenCalledWith("sklep-agenci", true));

    fireEvent.click(within(await row("Wolumen leverframe-sklep-agenci-home")).getByLabelText(/Usuń wolumen/));
    expect(screen.getByText(/Logowania agentów z niego przepadną/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Usuń"));
    await waitFor(() => expect(client.removeVolume).toHaveBeenCalledWith("leverframe-sklep-agenci-home"));

    fireEvent.click(within(await row("Obraz node:22")).getByLabelText("Usuń obraz node:22"));
    fireEvent.click(screen.getByText("Usuń"));
    await waitFor(() => expect(client.removeImage).toHaveBeenCalledWith("node:22"));
  });

  it("shows what failed", async () => {
    client.containerAction.mockRejectedValueOnce("Docker: Error response from daemon: conflict");
    render(<ContainersView />);
    fireEvent.click(within(await row("Kontener baza")).getByLabelText("Uruchom baza"));
    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  });

  it("pulls, builds and prunes images with progress", async () => {
    render(<ContainersView />);
    await row("Obraz node:22");
    fireEvent.click(screen.getByText("Pobierz…"));
    fireEvent.change(screen.getByLabelText("Obraz do pobrania"), { target: { value: "python:3.13" } });
    fireEvent.click(screen.getByText("Pobierz"));
    await waitFor(() => expect(client.pull).toHaveBeenCalledWith("python:3.13", expect.any(Function)));
    const job = await screen.findByRole("listitem", { name: "Pobieranie python:3.13" });
    act(() => emit({ type: "line", text: "3.13: Pulling from library/python" }));
    expect(within(job).getByRole("status")).toHaveTextContent("Pulling from library/python");
    fireEvent.click(within(job).getByText("Przerwij"));
    expect(client.cancel).toHaveBeenCalledWith(7);
    act(() => emit({ type: "done", ok: false, message: "Przerwano" }));
    expect(within(job).getByRole("status")).toHaveTextContent("Przerwano");
    fireEvent.click(within(job).getByLabelText("Zamknij"));
    expect(screen.queryByRole("listitem", { name: "Pobieranie python:3.13" })).toBeNull();

    fireEvent.click(screen.getByText("Zbuduj…"));
    const form = screen.getByRole("form", { name: "Zbuduj obraz" });
    fireEvent.click(within(form).getByText("Wybierz…"));
    await waitFor(() => expect(within(form).getByLabelText("Folder z plikiem Dockerfile")).toHaveValue("/home/me/projekty/Sklep Główny"));
    fireEvent.change(within(form).getByLabelText("Nazwa obrazu"), { target: { value: "sklep:1.0" } });
    fireEvent.click(within(form).getByText("Zbuduj"));
    await waitFor(() => expect(client.build).toHaveBeenCalledWith("/home/me/projekty/Sklep Główny", "sklep:1.0", expect.any(Function)));
    act(() => emit({ type: "done", ok: true, message: null }));
    expect(await screen.findByText("Gotowe.")).toBeInTheDocument();
    await waitFor(() => expect(client.images.mock.calls.length).toBeGreaterThan(1)); // refreshed

    // The folder can also be typed in (or pasted).
    fireEvent.click(screen.getByText("Zbuduj…"));
    const again = screen.getByRole("form", { name: "Zbuduj obraz" });
    fireEvent.change(within(again).getByLabelText("Folder z plikiem Dockerfile"), { target: { value: " /srv/obraz " } });
    fireEvent.change(within(again).getByLabelText("Nazwa obrazu"), { target: { value: "obraz:2" } });
    fireEvent.click(within(again).getByText("Zbuduj"));
    await waitFor(() => expect(client.build).toHaveBeenCalledWith("/srv/obraz", "obraz:2", expect.any(Function)));

    fireEvent.click(screen.getByLabelText("Usuń nieużywane obrazy"));
    fireEvent.click(screen.getByText("Usuń"));
    expect(await screen.findByText("Total reclaimed space: 1.2GB")).toBeInTheDocument();
  });

  it("builds the image with agents with one button", async () => {
    render(<ContainersView />);
    await row("Obraz node:22");
    // Built already: only the button in the toolbar.
    expect(screen.queryByLabelText("Obraz Leverframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zbuduj obraz Leverframe" }));
    const job = await screen.findByRole("listitem", { name: "Budowanie leverframe-agents:0.8.0" });
    expect(client.buildAgentsImage).toHaveBeenCalledTimes(1);
    act(() => emit({ type: "line", text: "#7 [3/5] RUN npm install -g" }));
    expect(within(job).getByRole("status")).toHaveTextContent("npm install");
    fireEvent.click(within(job).getByText("Przerwij"));
    expect(client.cancel).toHaveBeenCalledWith(9);
    act(() => emit({ type: "done", ok: true, message: null }));
    expect(await within(job).findByText("Gotowe.")).toBeInTheDocument();
  });

  it("offers the image with agents of this version when it is not built", async () => {
    client.agentsImage.mockResolvedValueOnce("leverframe-agents:0.9.0");
    render(<ContainersView />);
    const offer = await screen.findByLabelText("Obraz Leverframe");
    expect(offer).toHaveTextContent("leverframe-agents:0.9.0");
    fireEvent.click(within(offer).getByText("Zbuduj obraz Leverframe"));
    expect(await screen.findByRole("listitem", { name: "Budowanie leverframe-agents:0.9.0" })).toBeInTheDocument();
    // While it builds, the offer waits.
    expect(screen.queryByLabelText("Obraz Leverframe")).toBeNull();
  });

  it("creates a container for agents after showing the command", async () => {
    render(<ContainersView />);
    fireEvent.click(within(await row("Obraz leverframe-agents:0.8.0")).getByText("Nowy kontener"));
    const form = screen.getByRole("form", { name: "Nowy kontener" });
    expect(within(form).getByLabelText("Nazwa")).toHaveValue("sklep-agenci");
    expect(within(form).getByLabelText("Katalog domowy w kontenerze")).toHaveValue("/home/agent");
    expect(await within(form).findByText("docker run -d --name sklep-agenci leverframe-agents:0.8.0 sleep infinity")).toBeInTheDocument();

    // Another folder: the suggested name follows it.
    fireEvent.click(within(form).getByText("Wybierz…"));
    await waitFor(() => expect(within(form).getByLabelText("Nazwa")).toHaveValue("sklep-glowny-agenci"));
    fireEvent.change(within(form).getByLabelText(/Zmienne środowiskowe/), { target: { value: "NODE_ENV=dev\n" } });
    fireEvent.change(within(form).getByLabelText(/Porty/), { target: { value: "8080:80, 5173" } });
    await waitFor(() => expect(client.createPlan).toHaveBeenLastCalledWith(expect.objectContaining({ name: "sklep-glowny-agenci" })));

    fireEvent.click(within(form).getByText("Utwórz i uruchom"));
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({
        image: "leverframe-agents:0.8.0",
        name: "sklep-glowny-agenci",
        projectDir: "/home/me/projekty/Sklep Główny",
        homeVolume: true,
        homeDir: "/home/agent",
        env: [{ name: "NODE_ENV", value: "dev" }],
        ports: ["8080:80", "5173"],
        network: null,
        user: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("form", { name: "Nowy kontener" })).toBeNull());
  });

  it("needs warnings accepted and shows problems with the form", async () => {
    client.createPlan.mockResolvedValue({ args: [], command: "docker run …", volume: null, warnings: ["Do kontenera trafi cały folder /home/me"] });
    render(<ContainersView />);
    fireEvent.click(within(await row("Obraz node:22")).getByText("Nowy kontener"));
    const form = screen.getByRole("form", { name: "Nowy kontener" });
    expect(within(form).getByLabelText("Katalog domowy w kontenerze")).toHaveValue("/root");
    expect(await within(form).findByText(/cały folder/)).toBeInTheDocument();
    const create = within(form).getByText("Utwórz i uruchom");
    expect(create).toBeDisabled();
    fireEvent.click(within(form).getByLabelText("Rozumiem, utwórz mimo to"));
    expect(create).toBeEnabled();

    client.createPlan.mockRejectedValue("Sieć host nie jest dostępna");
    fireEvent.change(within(form).getByLabelText("Sieć Dockera"), { target: { value: "host" } });
    expect(await within(form).findByRole("alert")).toHaveTextContent("Sieć host nie jest dostępna");
    expect(create).toBeDisabled();
    fireEvent.click(within(form).getByText("Anuluj"));
    expect(screen.queryByRole("form", { name: "Nowy kontener" })).toBeNull();
    client.createPlan.mockReset();
  });
});
