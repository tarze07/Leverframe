import { invoke } from "@tauri-apps/api/core";

export type ProfileKind = "local" | "wsl" | "ssh" | "powershell";

export interface SshTarget {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
}

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  icon?: string;
  description?: string;
  ssh?: SshTarget;
  source: "detected" | "user";
}

export interface ProfilesState {
  profiles: Profile[];
  defaultProfileId: string | null;
}

export const profilesClient = {
  list: () => invoke<ProfilesState>("profiles_list"),
  refresh: () => invoke<ProfilesState>("profiles_refresh"),
  save: (profile: Profile) => invoke<Profile>("profile_save", { profile }),
  remove: (id: string) => invoke<void>("profile_delete", { id }),
  setDefault: (id: string) => invoke<void>("profile_set_default", { id }),
};

export const KIND_ORDER: ProfileKind[] = ["local", "wsl", "ssh", "powershell"];

export const KIND_LABELS: Record<ProfileKind, string> = {
  local: "Lokalne",
  wsl: "WSL",
  ssh: "SSH",
  powershell: "PowerShell",
};

/** Codicon for a profile. */
export function profileIcon(p: Pick<Profile, "kind" | "name" | "id" | "icon">): string {
  if (p.icon) return p.icon;
  const name = p.name.toLowerCase();
  switch (p.kind) {
    case "powershell":
      return "terminal-powershell";
    case "ssh":
      return "remote";
    case "wsl":
      if (name.includes("ubuntu")) return "terminal-ubuntu";
      if (name.includes("debian")) return "terminal-debian";
      return "terminal-linux";
    default:
      return p.id === "local:cmd" ? "terminal-cmd" : "terminal-bash";
  }
}

export function groupProfiles(profiles: Profile[]): [ProfileKind, Profile[]][] {
  return KIND_ORDER.map((kind) => [kind, profiles.filter((p) => p.kind === kind)] as [ProfileKind, Profile[]]).filter(
    ([, list]) => list.length > 0,
  );
}

export interface SshFormValues {
  name: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
}

/** Validates the "add SSH host" form; mirrors the backend checks. Returns field errors. */
export function validateSshForm(v: SshFormValues): Partial<Record<keyof SshFormValues, string>> {
  const errors: Partial<Record<keyof SshFormValues, string>> = {};
  const unsafe = (s: string) => s.startsWith("-") || /[\s@]/.test(s);
  const host = v.host.trim();
  if (!host) errors.host = "Podaj adres hosta";
  else if (unsafe(host)) errors.host = "Nieprawidłowy host (bez spacji, „@” i „-” na początku)";
  if (v.port.trim()) {
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Port musi być w zakresie 1–65535";
  }
  const user = v.user.trim();
  if (user && unsafe(user)) errors.user = "Nieprawidłowa nazwa użytkownika";
  return errors;
}

export function sshFormToProfile(v: SshFormValues, existing?: Profile): Profile {
  const port = v.port.trim() ? Number(v.port) : undefined;
  return {
    id: existing?.id ?? "",
    name: v.name.trim() || v.host.trim(),
    kind: "ssh",
    command: "ssh",
    args: [],
    source: "user",
    ssh: {
      host: v.host.trim(),
      port,
      user: v.user.trim() || undefined,
      identityFile: v.identityFile.trim() || undefined,
    },
  };
}

export function profileToSshForm(p?: Profile): SshFormValues {
  return {
    name: p?.name ?? "",
    host: p?.ssh?.host ?? "",
    port: p?.ssh?.port ? String(p.ssh.port) : "",
    user: p?.ssh?.user ?? "",
    identityFile: p?.ssh?.identityFile ?? "",
  };
}
