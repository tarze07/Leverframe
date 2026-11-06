import { describe, expect, it } from "vitest";
import {
  groupProfiles,
  profileIcon,
  profileToSshForm,
  sshFormToProfile,
  validateSshForm,
  type Profile,
} from "./profilesClient";

const p = (id: string, kind: Profile["kind"], name = id): Profile => ({
  id,
  name,
  kind,
  command: "x",
  args: [],
  source: "detected",
});

describe("profiles helpers", () => {
  it("groups profiles in a fixed kind order and skips empty groups", () => {
    const groups = groupProfiles([p("ps", "powershell"), p("bash", "local"), p("srv", "ssh")]);
    expect(groups.map(([k]) => k)).toEqual(["local", "ssh", "powershell"]);
  });

  it("picks icons per kind and distro", () => {
    expect(profileIcon(p("wsl:Ubuntu-22.04", "wsl", "Ubuntu-22.04"))).toBe("terminal-ubuntu");
    expect(profileIcon(p("wsl:Arch", "wsl", "Arch"))).toBe("terminal-linux");
    expect(profileIcon(p("powershell:pwsh", "powershell"))).toBe("terminal-powershell");
    expect(profileIcon(p("ssh-config:x", "ssh"))).toBe("remote");
    expect(profileIcon(p("local:cmd", "local"))).toBe("terminal-cmd");
    expect(profileIcon(p("local:zsh", "local"))).toBe("terminal-bash");
  });

  it("validates the SSH form", () => {
    const base = { name: "", host: "example.com", port: "", user: "", identityFile: "" };
    expect(validateSshForm(base)).toEqual({});
    expect(validateSshForm({ ...base, host: " " }).host).toBeDefined();
    expect(validateSshForm({ ...base, host: "-oProxyCommand=x" }).host).toBeDefined();
    expect(validateSshForm({ ...base, host: "me@host" }).host).toBeDefined();
    expect(validateSshForm({ ...base, port: "70000" }).port).toBeDefined();
    expect(validateSshForm({ ...base, port: "abc" }).port).toBeDefined();
    expect(validateSshForm({ ...base, port: "2222" })).toEqual({});
    expect(validateSshForm({ ...base, user: "a b" }).user).toBeDefined();
  });

  it("maps the SSH form to a profile and back", () => {
    const values = { name: " ", host: " srv.local ", port: "2222", user: "dev", identityFile: "~/.ssh/key" };
    const profile = sshFormToProfile(values);
    expect(profile).toMatchObject({
      id: "",
      name: "srv.local",
      kind: "ssh",
      source: "user",
      ssh: { host: "srv.local", port: 2222, user: "dev", identityFile: "~/.ssh/key" },
    });
    expect(profileToSshForm({ ...profile, id: "user-1" })).toEqual({
      name: "srv.local",
      host: "srv.local",
      port: "2222",
      user: "dev",
      identityFile: "~/.ssh/key",
    });
    expect(sshFormToProfile({ ...values, port: "", user: "" }).ssh).toEqual({
      host: "srv.local",
      port: undefined,
      user: undefined,
      identityFile: "~/.ssh/key",
    });
  });
});
