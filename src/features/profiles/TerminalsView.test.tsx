import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "./profilesClient";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
vi.mock("../../lib/tauri", () => ({ isTauri: () => true }));
const openProfile = vi.fn();
const revealTerminal = vi.fn();
const closeTerminal = vi.fn();
vi.mock("../../workbench/commands", () => ({
  openProfile: (...a: unknown[]) => openProfile(...a),
  revealTerminal: (...a: unknown[]) => revealTerminal(...a),
  closeTerminal: (...a: unknown[]) => closeTerminal(...a),
}));

import { TerminalsView } from "./TerminalsView";
import { useProfilesStore } from "../../store/profiles";
import { useTerminalStore } from "../../store/terminal";

const profile = (id: string, kind: Profile["kind"], extra: Partial<Profile> = {}): Profile => ({
  id,
  name: id.split(":").pop()!,
  kind,
  command: "x",
  args: [],
  source: "detected",
  ...extra,
});

const state = {
  profiles: [
    profile("local:bash", "local", { description: "/bin/bash" }),
    profile("wsl:Ubuntu", "wsl"),
    profile("powershell:pwsh", "powershell"),
    profile("user-1", "ssh", { name: "prod", source: "user", ssh: { host: "prod.example.com", user: "dev" } }),
  ],
  defaultProfileId: "local:bash",
};

describe("TerminalsView", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "profiles_list" || cmd === "profiles_refresh") return state;
      if (cmd === "profile_save") return { ...state.profiles[3], id: "user-2" };
      return undefined;
    });
    useProfilesStore.setState({ status: "idle", profiles: [], defaultProfileId: null, error: null });
    useTerminalStore.setState({ running: [], activePanelId: null });
  });
  afterEach(() => vi.clearAllMocks());

  it("lists profiles grouped by kind and marks the default", async () => {
    render(<TerminalsView />);
    await screen.findByText("bash");
    for (const group of ["Lokalne", "WSL", "SSH", "PowerShell"]) {
      expect(screen.getByRole("button", { name: group })).toBeInTheDocument();
    }
    expect(screen.getByText("domyślny")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Otwórz Ubuntu/));
    expect(openProfile).toHaveBeenCalledWith("wsl:Ubuntu");
  });

  it("opens in split, sets default and deletes user profiles", async () => {
    render(<TerminalsView />);
    const row = (await screen.findByText("Ubuntu")).closest("li")!;
    fireEvent.click(within(row).getByLabelText("Otwórz w podziale"));
    expect(openProfile).toHaveBeenCalledWith("wsl:Ubuntu", { split: "right" });

    fireEvent.click(within(row).getByLabelText("Ustaw jako domyślny"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("profile_set_default", { id: "wsl:Ubuntu" }));

    // Detected profiles cannot be edited or deleted.
    expect(within(row).queryByLabelText("Usuń")).toBeNull();
    const userRow = screen.getByText("prod").closest("li")!;
    fireEvent.click(within(userRow).getByLabelText("Usuń"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("profile_delete", { id: "user-1" }));
  });

  it("adds an SSH host through the form with validation", async () => {
    render(<TerminalsView />);
    await screen.findByText("bash");
    fireEvent.click(screen.getByLabelText("Dodaj host SSH"));

    const form = screen.getByRole("form", { name: "Host SSH" });
    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "-oProxyCommand=x" } });
    fireEvent.click(within(form).getByText("Zapisz"));
    expect(await within(form).findByText(/Nieprawidłowy host/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("profile_save", expect.anything());

    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "srv.local" } });
    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "2222" } });
    fireEvent.change(within(form).getByLabelText("Użytkownik"), { target: { value: "dev" } });
    await act(async () => fireEvent.click(within(form).getByText("Zapisz")));
    expect(invoke).toHaveBeenCalledWith("profile_save", {
      profile: expect.objectContaining({ kind: "ssh", ssh: { host: "srv.local", port: 2222, user: "dev", identityFile: undefined } }),
    });
    await screen.findByText("bash"); // back to the list
  });

  it("edits an existing SSH host", async () => {
    render(<TerminalsView />);
    const userRow = (await screen.findByText("prod")).closest("li")!;
    fireEvent.click(within(userRow).getByLabelText("Edytuj"));
    expect(screen.getByLabelText("Host")).toHaveValue("prod.example.com");
    expect(screen.getByLabelText("Użytkownik")).toHaveValue("dev");
    fireEvent.click(screen.getByText("Anuluj"));
    await screen.findByText("bash");
  });

  it("shows running terminals and lets you switch to or close them", async () => {
    useTerminalStore.setState({
      running: [{ panelId: "terminal-1", dock: "panel", title: "root@vm: ~", profileId: "local:bash", exited: false }],
    });
    render(<TerminalsView />);
    const row = (await screen.findByText("root@vm: ~")).closest("li")!;
    expect(screen.getByText("Uruchomione (1)")).toBeInTheDocument();
    fireEvent.click(within(row).getByText("root@vm: ~"));
    expect(revealTerminal).toHaveBeenCalledWith("terminal-1", "panel");
    fireEvent.click(within(row).getByLabelText("Zamknij terminal"));
    expect(closeTerminal).toHaveBeenCalledWith("terminal-1", "panel");
  });
});
