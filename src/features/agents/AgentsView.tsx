import { useEffect, useId, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useProfilesStore } from "../../store/profiles";
import { openAgent } from "../../workbench/commands";
import { groupProfiles, KIND_LABELS } from "../profiles/profilesClient";
import { folderName, type Agent, type AgentStatus } from "./agentsClient";

/** Sidebar view: AI coding agents, their availability in the chosen profile, and launching them. */
export function AgentsView() {
  const { agents, errors, configPath, profileId, projectDir, detection, load, setProfile, detect, setProjectDir } =
    useAgentsStore();
  const profiles = useProfilesStore((s) => s.profiles);
  const defaultProfileId = useProfilesStore((s) => s.defaultProfileId);
  const loadProfiles = useProfilesStore((s) => s.load);
  const selectId = useId();
  const [dirError, setDirError] = useState<string | null>(null);

  const effectiveProfileId = profileId ?? defaultProfileId;
  const profile = profiles.find((p) => p.id === effectiveProfileId);
  const state = effectiveProfileId ? detection[effectiveProfileId] : undefined;

  useEffect(() => {
    void load();
    void loadProfiles();
  }, [load, loadProfiles]);

  useEffect(() => {
    if (effectiveProfileId && agents.length > 0) void detect(effectiveProfileId);
  }, [effectiveProfileId, agents.length, detect]);

  if (!isTauri()) {
    return (
      <Placeholder icon="hubot" title="Agenci CLI">
        Uruchamianie agentów jest dostępne w aplikacji desktopowej (<code className="font-mono">npm run tauri dev</code>).
      </Placeholder>
    );
  }

  const pickFolder = async () => {
    setDirError(null);
    try {
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: projectDir ?? undefined });
      if (typeof picked === "string") await setProjectDir(picked);
    } catch (e) {
      setDirError(String(e));
    }
  };

  const statusFor = (id: string): AgentStatus | undefined =>
    state?.status === "ready" ? state.results.find((r) => r.id === id) : undefined;

  return (
    <div className="flex flex-col gap-3 px-3 pb-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-[11px] text-lf-muted">
          Uruchamiaj w terminalu
        </label>
        <div className="flex items-center gap-1">
          <select
            id={selectId}
            value={effectiveProfileId ?? ""}
            onChange={(e) => setProfile(e.target.value || null)}
            className="min-w-0 flex-1 rounded border border-lf-border bg-lf-editor px-1.5 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent"
          >
            {groupProfiles(profiles).map(([kind, list]) => (
              <optgroup key={kind} label={KIND_LABELS[kind]}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === defaultProfileId ? " (domyślny)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            title="Sprawdź ponownie"
            aria-label="Sprawdź ponownie"
            disabled={!effectiveProfileId}
            onClick={() => effectiveProfileId && void detect(effectiveProfileId, true)}
            className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
          >
            <span className={`codicon codicon-refresh ${state?.status === "loading" ? "codicon-modifier-spin" : ""}`} aria-hidden />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-lf-muted">Folder projektu</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void pickFolder()}
            title={projectDir ?? "Wybierz folder, w którym agenci będą pracować"}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-lf-border bg-lf-editor px-1.5 py-1 text-left text-xs hover:border-lf-accent"
          >
            <span className="codicon codicon-folder text-lf-muted" aria-hidden />
            <span className={`truncate ${projectDir ? "text-lf-fg" : "text-lf-subtle"}`}>
              {projectDir ? folderName(projectDir) : "Folder domowy (wybierz…)"}
            </span>
          </button>
          {projectDir && (
            <button
              type="button"
              title="Użyj folderu domowego"
              aria-label="Wyczyść folder projektu"
              onClick={() => void setProjectDir(null)}
              className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
            >
              <span className="codicon codicon-close" aria-hidden />
            </button>
          )}
        </div>
        {profile?.kind === "ssh" && (
          <span className="text-[11px] text-lf-subtle">Na hostach SSH agent startuje w katalogu domowym.</span>
        )}
        {dirError && <span className="text-[11px] text-lf-danger">{dirError}</span>}
      </div>

      {state?.status === "error" && (
        <p className="rounded border border-lf-border bg-lf-editor p-2 text-[11px] text-lf-danger">{state.error}</p>
      )}

      <ul className="flex flex-col gap-2" aria-label="Agenci">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            status={statusFor(a.id)}
            checking={state?.status === "loading"}
            onLaunch={(split) =>
              openAgent(a.id, {
                profileId: effectiveProfileId,
                cwd: profile?.kind === "ssh" ? null : projectDir,
                split,
              })
            }
          />
        ))}
      </ul>

      {errors.length > 0 && (
        <div className="text-[11px] text-lf-danger">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      {configPath && (
        <p className="text-[11px] leading-relaxed text-lf-subtle">
          Własnych agentów dodasz w pliku <code className="break-all font-mono">{configPath}</code>.
        </p>
      )}
    </div>
  );
}

function AgentCard(props: {
  agent: Agent;
  status?: AgentStatus;
  checking: boolean;
  onLaunch: (split?: "right") => void;
}) {
  const { agent, status } = props;
  const [showInstall, setShowInstall] = useState(false);
  const installed = status?.installed ?? false;

  let badge: React.ReactNode;
  if (props.checking && !status) badge = <span className="text-lf-subtle">sprawdzanie…</span>;
  else if (installed)
    badge = (
      <span className="flex min-w-0 items-center gap-1 text-lf-fg">
        <span className="codicon codicon-pass-filled text-[#98c379]" aria-hidden />
        <span className="truncate">{status?.version ?? status?.command ?? "zainstalowany"}</span>
      </span>
    );
  else if (status) badge = <span className="text-lf-subtle">nie znaleziono</span>;

  return (
    <li className="rounded border border-lf-border bg-lf-editor p-2" aria-label={agent.name}>
      <div className="flex items-start gap-2">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-lf-elevated text-sm font-semibold text-lf-accent"
          aria-hidden
        >
          {agent.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-lf-fg">{agent.name}</span>
            <code className="truncate font-mono text-[11px] text-lf-subtle">{status?.command ?? agent.commands[0]}</code>
          </div>
          {agent.description && <p className="truncate text-[11px] text-lf-muted">{agent.description}</p>}
          <div className="mt-0.5 text-[11px]">{badge}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => props.onLaunch()}
          title={installed ? `Uruchom ${agent.name}` : `Uruchom ${agent.name} (nie wykryto – może nie zadziałać)`}
          className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
            installed ? "bg-lf-accent text-lf-accent-fg hover:opacity-90" : "border border-lf-border text-lf-muted hover:text-lf-fg"
          }`}
        >
          <span className="codicon codicon-play" aria-hidden />
          Uruchom
        </button>
        <button
          type="button"
          title="Uruchom w podziale"
          aria-label={`Uruchom ${agent.name} w podziale`}
          onClick={() => props.onLaunch("right")}
          className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
        >
          <span className="codicon codicon-split-horizontal" aria-hidden />
        </button>
        {status && !installed && (agent.install.length > 0 || agent.docsUrl) && (
          <button
            type="button"
            onClick={() => setShowInstall((v) => !v)}
            aria-expanded={showInstall}
            className="ml-auto text-[11px] text-lf-accent hover:underline"
          >
            Jak zainstalować?
          </button>
        )}
      </div>
      {showInstall && (
        <div className="mt-2 flex flex-col gap-1">
          {agent.install.map((hint) => (
            <div key={hint.command} className="flex items-center gap-1 rounded bg-lf-bg p-1">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-lf-fg" title={hint.command}>
                {hint.command}
              </code>
              <button
                type="button"
                title="Kopiuj"
                aria-label="Kopiuj komendę instalacji"
                onClick={() => void writeText(hint.command).catch(() => undefined)}
                className="rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
              >
                <span className="codicon codicon-copy" aria-hidden />
              </button>
            </div>
          ))}
          <p className="text-[11px] text-lf-subtle">
            Wklej komendę w terminalu tego profilu. Leverframe niczego nie instaluje sam.
          </p>
          {agent.docsUrl && (
            <button
              type="button"
              onClick={() => void openUrl(agent.docsUrl!).catch(() => undefined)}
              className="self-start text-[11px] text-lf-accent hover:underline"
            >
              Dokumentacja instalacji
            </button>
          )}
        </div>
      )}
    </li>
  );
}
