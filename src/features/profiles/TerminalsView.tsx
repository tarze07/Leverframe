import { useEffect, useState } from "react";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useProfilesStore } from "../../store/profiles";
import { useTerminalStore, type RunningTerminal } from "../../store/terminal";
import { closeTerminal, openProfile, revealTerminal } from "../../workbench/commands";
import { groupProfiles, KIND_LABELS, profileIcon, type Profile, type ProfileKind } from "./profilesClient";
import { SshProfileForm } from "./SshProfileForm";

type Mode = { type: "list" } | { type: "edit"; profile?: Profile };

/** Sidebar view: running terminals and available terminal profiles. */
export function TerminalsView() {
  const { profiles, defaultProfileId, status, error, load, refresh, save, remove, setDefault } = useProfilesStore();
  const running = useTerminalStore((s) => s.running);
  const [mode, setMode] = useState<Mode>({ type: "list" });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void load();
  }, [load]);

  if (!isTauri()) {
    return (
      <Placeholder icon="terminal" title="Profile terminali">
        Lista profili jest dostępna w aplikacji desktopowej (<code className="font-mono">npm run tauri dev</code>).
      </Placeholder>
    );
  }

  if (mode.type === "edit") {
    return (
      <SshProfileForm
        profile={mode.profile}
        onCancel={() => setMode({ type: "list" })}
        onSave={async (p) => {
          await save(p);
          setMode({ type: "list" });
        }}
      />
    );
  }

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-1 px-3 pb-1">
        <ToolbarButton icon="add" label="Dodaj host SSH" onClick={() => setMode({ type: "edit" })} />
        <ToolbarButton
          icon="refresh"
          label="Wykryj profile ponownie"
          onClick={() => void refresh()}
          spinning={status === "loading"}
        />
      </div>

      {error && <p className="px-4 py-1 text-[11px] text-lf-danger">{error}</p>}

      <Section title={`Uruchomione (${running.length})`} collapsed={!!collapsed.running} onToggle={() => toggle("running")}>
        {running.length === 0 ? (
          <p className="px-6 py-1 text-xs text-lf-subtle">Brak uruchomionych terminali</p>
        ) : (
          running.map((t) => <RunningRow key={t.panelId} terminal={t} profile={profiles.find((p) => p.id === t.profileId)} />)
        )}
      </Section>

      {status === "loading" && profiles.length === 0 && <p className="px-4 py-2 text-xs text-lf-muted">Wykrywanie profili…</p>}

      {groupProfiles(profiles).map(([kind, list]) => (
        <Section key={kind} title={KIND_LABELS[kind as ProfileKind]} collapsed={!!collapsed[kind]} onToggle={() => toggle(kind)}>
          {list.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              isDefault={p.id === defaultProfileId}
              onEdit={p.source === "user" && p.ssh ? () => setMode({ type: "edit", profile: p }) : undefined}
              onDelete={p.source === "user" ? () => void remove(p.id) : undefined}
              onSetDefault={() => void setDefault(p.id)}
            />
          ))}
        </Section>
      ))}

      {status === "ready" && !profiles.some((p) => p.kind === "ssh") && (
        <Section title={KIND_LABELS.ssh} collapsed={!!collapsed.ssh} onToggle={() => toggle("ssh")}>
          <button
            type="button"
            onClick={() => setMode({ type: "edit" })}
            className="mx-6 my-1 text-left text-xs text-lf-accent hover:underline"
          >
            Dodaj host SSH…
          </button>
        </Section>
      )}
    </div>
  );
}

function Section(props: { title: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="mt-1">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-lf-muted hover:text-lf-fg"
      >
        <span className={`codicon codicon-chevron-${props.collapsed ? "right" : "down"}`} aria-hidden />
        {props.title}
      </button>
      {!props.collapsed && <ul className="flex flex-col">{props.children}</ul>}
    </section>
  );
}

function ProfileRow(props: {
  profile: Profile;
  isDefault: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onSetDefault: () => void;
}) {
  const { profile: p } = props;
  return (
    <li className="group relative flex items-center hover:bg-lf-hover">
      <button
        type="button"
        onClick={() => openProfile(p.id)}
        onDoubleClick={(e) => e.preventDefault()}
        title={`Otwórz ${p.name}${p.description ? ` (${p.description})` : ""}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-6 pr-2 text-left"
      >
        <span className={`codicon codicon-${profileIcon(p)} shrink-0 text-lf-muted`} aria-hidden />
        <span className="max-w-[70%] shrink-0 truncate text-[13px] text-lf-fg">{p.name}</span>
        {props.isDefault && <span className="shrink-0 text-[10px] uppercase text-lf-accent">domyślny</span>}
        {p.description && <span className="min-w-0 truncate text-xs text-lf-subtle">{p.description}</span>}
      </button>
      <div className="absolute right-1 hidden items-center gap-0.5 bg-lf-hover group-focus-within:flex group-hover:flex">
        <RowAction icon="split-horizontal" label="Otwórz w podziale" onClick={() => openProfile(p.id, { split: "right" })} />
        {!props.isDefault && <RowAction icon="star-empty" label="Ustaw jako domyślny" onClick={props.onSetDefault} />}
        {props.onEdit && <RowAction icon="edit" label="Edytuj" onClick={props.onEdit} />}
        {props.onDelete && <RowAction icon="trash" label="Usuń" onClick={props.onDelete} />}
      </div>
    </li>
  );
}

function RunningRow({ terminal: t, profile }: { terminal: RunningTerminal; profile?: Profile }) {
  const active = useTerminalStore((s) => s.activePanelId === t.panelId);
  return (
    <li className={`group relative flex items-center hover:bg-lf-hover ${active ? "bg-lf-hover" : ""}`}>
      <button
        type="button"
        onClick={() => revealTerminal(t.panelId, t.dock)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-6 pr-2 text-left"
      >
        <span
          className={`codicon codicon-${profile ? profileIcon(profile) : "terminal"} shrink-0 ${
            t.exited ? "text-lf-subtle" : "text-lf-muted"
          }`}
          aria-hidden
        />
        <span className={`truncate text-[13px] ${t.exited ? "text-lf-subtle line-through" : "text-lf-fg"}`}>{t.title}</span>
        {profile && profile.name !== t.title && <span className="truncate text-xs text-lf-subtle">{profile.name}</span>}
      </button>
      <div className="absolute right-1 hidden items-center bg-lf-hover group-focus-within:flex group-hover:flex">
        <RowAction icon="close" label="Zamknij terminal" onClick={() => closeTerminal(t.panelId, t.dock)} />
      </div>
    </li>
  );
}

function RowAction({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-0.5 text-lf-muted hover:bg-lf-elevated hover:text-lf-fg"
    >
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

function ToolbarButton(props: { icon: string; label: string; onClick: () => void; spinning?: boolean }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
    >
      <span className={`codicon codicon-${props.icon} ${props.spinning ? "codicon-modifier-spin" : ""}`} aria-hidden />
    </button>
  );
}
