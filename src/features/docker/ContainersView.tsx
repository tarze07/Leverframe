import { useEffect, useId, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useDockerStore, type DockerJob } from "../../store/docker";
import { openContainerLogs } from "../../workbench/commands";
import { useProfilesStore } from "../../store/profiles";
import { addContainerProfile, openContainerTerminal } from "./containerTerminal";
import { dockerClient, imageName, type DockerContainer, type DockerImage } from "./dockerClient";
import { NewContainerForm, fieldClass } from "./NewContainerForm";

const smallButton = "rounded px-1.5 py-0.5 text-[11px] text-lf-fg hover:bg-lf-hover disabled:opacity-50";
const iconButton = "rounded p-0.5 text-lf-muted hover:bg-lf-elevated hover:text-lf-fg disabled:opacity-50";
const AGENTS_IMAGE_HINT =
  "Zbuduj obraz z agentami Claude Code i OpenCode z trybem rozmowy (plik Dockerfile dołączony do Leverframe, packaging/docker/agents)";

/** Sidebar view: Docker's images, containers and Leverframe's volumes, managed from here. */
export function ContainersView() {
  if (!isTauri()) {
    return (
      <Placeholder icon="package" title="Kontenery Docker">
        Kontenery są dostępne w aplikacji desktopowej.
      </Placeholder>
    );
  }
  return <Containers />;
}

function Containers() {
  const { info, images, containers, volumes, agentsImage, status, error, refresh, clearError, jobs, buildAgentsImage, sources, source, setSource } =
    useDockerStore();
  const sourceId = useId();
  const chosen = sources.find((s) => s.id === source);
  const [newFrom, setNewFrom] = useState<DockerImage | null>(null);

  useEffect(() => {
    void refresh();
    // The project folder (from the "Agenci" view) is the default of new containers.
    void useAgentsStore.getState().load();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3 px-3 pb-4 text-xs">
      {sources.length > 1 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={sourceId} className="text-[11px] text-lf-muted">
            Docker na
          </label>
          <select
            id={sourceId}
            value={source ?? ""}
            onChange={(e) => void setSource(e.target.value || null)}
            className="rounded border border-lf-border bg-lf-editor px-1.5 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent"
          >
            {sources.map((s) => (
              <option key={s.id ?? ""} value={s.id ?? ""}>
                {s.id ? `${s.name} (SSH)` : s.name}
              </option>
            ))}
          </select>
          {chosen?.url && (
            <span className="text-[11px] text-lf-subtle">
              Przez SSH: <code className="font-mono">{chosen.url}</code>. Foldery projektów są na tym serwerze; agent w kontenerze korzysta z własnych plików.
            </span>
          )}
          {chosen?.warning && <span className="text-[11px] text-lf-danger">{chosen.warning}</span>}
        </div>
      )}
      <section aria-label="Docker" className="flex items-center gap-2">
        <span className={`codicon ${info?.running ? "codicon-pass-filled text-lf-accent" : "codicon-circle-slash text-lf-muted"}`} aria-hidden />
        <span className="min-w-0 flex-1 text-lf-fg">
          {info === null
            ? "Sprawdzanie Dockera…"
            : info.running
              ? `Docker ${info.serverVersion ?? ""}${info.serverOs ? ` (${info.serverOs})` : ""}`
              : "Docker nie jest dostępny"}
        </span>
        <button type="button" title="Odśwież" aria-label="Odśwież" onClick={() => void refresh()} className={iconButton} disabled={status === "loading"}>
          <span className={`codicon codicon-refresh ${status === "loading" ? "codicon-modifier-spin" : ""}`} aria-hidden />
        </button>
      </section>
      {info && !info.running && info.message && (
        <p role="alert" className="rounded border border-lf-border p-2 leading-relaxed text-lf-fg">
          {info.message}
        </p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1 rounded border border-lf-danger/50 p-2 text-lf-danger">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button type="button" aria-label="Zamknij komunikat" onClick={clearError} className={iconButton}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </p>
      )}

      {info?.running && (
        <>
          {jobs.length > 0 && (
            <ul aria-label="Zadania Dockera" className="flex flex-col gap-1">
              {jobs.map((j) => (
                <JobCard key={j.key} job={j} />
              ))}
            </ul>
          )}

          <Section title={`Obrazy (${images.length})`} actions={<ImageActions />}>
            {agentsImage && !images.some((i) => imageName(i) === agentsImage) && !jobs.some((j) => !j.done && j.title.endsWith(agentsImage)) && (
              <div aria-label="Obraz Leverframe" className="mb-1 flex flex-col gap-1 rounded border border-lf-border p-2">
                <p className="text-lf-fg">
                  Obraz z agentami (<span className="font-mono">{agentsImage}</span>): Claude Code i OpenCode z trybem rozmowy, gotowy na kontener
                  projektu.
                </p>
                <button type="button" title={AGENTS_IMAGE_HINT} onClick={() => void buildAgentsImage()} className="self-start rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90">
                  Zbuduj obraz Leverframe
                </button>
              </div>
            )}
            {newFrom && <NewContainerForm image={newFrom} onDone={() => setNewFrom(null)} />}
            <ul aria-label="Obrazy" className="flex flex-col gap-0.5">
              {images.map((i) => (
                <ImageRow key={i.id + (i.tag ?? "")} image={i} onNewContainer={() => setNewFrom(i)} />
              ))}
            </ul>
            {images.length === 0 && <p className="text-lf-subtle">Brak obrazów. Pobierz obraz albo zbuduj go z pliku Dockerfile.</p>}
          </Section>

          <Section title={`Kontenery (${containers.length})`}>
            <ul aria-label="Kontenery" className="flex flex-col gap-0.5">
              {containers.map((c) => (
                <ContainerRow key={c.id} container={c} />
              ))}
            </ul>
            {containers.length === 0 && <p className="text-lf-subtle">Brak kontenerów. Utwórz go z obrazu („Nowy kontener”).</p>}
          </Section>

          {volumes.some((v) => v.leverframe) && (
            <Section title="Wolumeny Leverframe">
              <ul aria-label="Wolumeny" className="flex flex-col gap-0.5">
                {volumes
                  .filter((v) => v.leverframe)
                  .map((v) => (
                    <VolumeRow key={v.name} name={v.name} />
                  ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1 border-b border-lf-border pb-0.5">
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-lf-muted">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** An inline "are you sure" for removals. */
function Confirm({ question, onYes, onNo }: { question: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1">
      <span className="text-lf-fg">{question}</span>
      <button type="button" onClick={onYes} className="rounded bg-lf-danger px-2 py-0.5 text-white">
        Usuń
      </button>
      <button type="button" onClick={onNo} className="text-lf-muted hover:text-lf-fg">
        Anuluj
      </button>
    </div>
  );
}

function ImageActions() {
  const { pull, build, buildAgentsImage, act } = useDockerStore();
  const [mode, setMode] = useState<"pull" | "build" | "prune" | null>(null);
  const [image, setImage] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [freed, setFreed] = useState<string | null>(null);
  const pullId = useId();
  const tagId = useId();

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDir(picked);
  };

  return (
    <>
      <button type="button" title={AGENTS_IMAGE_HINT} aria-label="Zbuduj obraz Leverframe" className={iconButton} onClick={() => void buildAgentsImage()}>
        <span className="codicon codicon-package" aria-hidden />
      </button>
      <button type="button" className={smallButton} onClick={() => setMode(mode === "pull" ? null : "pull")} aria-expanded={mode === "pull"}>
        Pobierz…
      </button>
      <button type="button" className={smallButton} onClick={() => setMode(mode === "build" ? null : "build")} aria-expanded={mode === "build"}>
        Zbuduj…
      </button>
      <button type="button" title="Usuń nieużywane obrazy" aria-label="Usuń nieużywane obrazy" className={iconButton} onClick={() => setMode("prune")}>
        <span className="codicon codicon-clear-all" aria-hidden />
      </button>
      {mode && (
        <div className="basis-full">
          {mode === "pull" && (
            <form
              className="mt-1 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!image.trim()) return;
                void pull(image.trim());
                setImage("");
                setMode(null);
              }}
            >
              <label htmlFor={pullId} className="sr-only">
                Obraz do pobrania
              </label>
              <input id={pullId} autoFocus value={image} onChange={(e) => setImage(e.target.value)} placeholder="np. node:22-bookworm-slim" className={`${fieldClass} font-mono`} />
              <button type="submit" className="shrink-0 rounded bg-lf-accent px-2 text-lf-accent-fg">
                Pobierz
              </button>
            </form>
          )}
          {mode === "build" && (
            <form
              aria-label="Zbuduj obraz"
              className="mt-1 flex flex-col gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!dir?.trim() || !tag.trim()) return;
                void build(dir.trim(), tag.trim());
                setMode(null);
              }}
            >
              <div className="flex gap-1">
                <input
                  value={dir ?? ""}
                  onChange={(e) => setDir(e.target.value || null)}
                  placeholder="folder z plikiem Dockerfile"
                  aria-label="Folder z plikiem Dockerfile"
                  title={dir ?? undefined}
                  className={`${fieldClass} min-w-0 flex-1 font-mono`}
                />
                <button type="button" onClick={() => void pickDir()} className="shrink-0 rounded border border-lf-border px-2 text-lf-fg hover:bg-lf-hover">
                  Wybierz…
                </button>
              </div>
              <label htmlFor={tagId} className="sr-only">
                Nazwa obrazu
              </label>
              <input id={tagId} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="nazwa obrazu, np. moj-obraz:1.0" className={`${fieldClass} font-mono`} />
              <button type="submit" disabled={!dir?.trim() || !tag.trim()} className="self-start rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg disabled:opacity-50">
                Zbuduj
              </button>
            </form>
          )}
          {mode === "prune" && (
            <Confirm
              question="Usunąć obrazy, których nie używa żaden kontener?"
              onNo={() => setMode(null)}
              onYes={() => {
                setMode(null);
                void act("prune", async () => setFreed((await dockerClient.pruneImages()) || "Nic do usunięcia."));
              }}
            />
          )}
        </div>
      )}
      {freed && (
        <p className="basis-full text-[11px] text-lf-subtle" role="status">
          {freed}
        </p>
      )}
    </>
  );
}

function ImageRow({ image, onNewContainer }: { image: DockerImage; onNewContainer: () => void }) {
  const { act, busy } = useDockerStore();
  const [confirm, setConfirm] = useState(false);
  const name = imageName(image);
  return (
    <li aria-label={`Obraz ${name}`} className="group rounded hover:bg-lf-hover">
      <div className="flex items-center gap-1 px-1 py-0.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-lf-fg" title={name}>
            {name}
            {image.leverframe && <span className="ml-1 rounded bg-lf-accent/20 px-1 font-sans text-[10px] text-lf-accent">agenci</span>}
          </span>
          <span className="text-[11px] text-lf-subtle">
            {image.size} · {image.createdSince}
          </span>
        </span>
        <button type="button" className={smallButton} onClick={onNewContainer}>
          Nowy kontener
        </button>
        <button type="button" aria-label={`Usuń obraz ${name}`} title="Usuń obraz" className={iconButton} disabled={busy[name]} onClick={() => setConfirm(true)}>
          <span className="codicon codicon-trash" aria-hidden />
        </button>
      </div>
      {confirm && (
        <Confirm
          question={`Usunąć obraz ${name}?`}
          onNo={() => setConfirm(false)}
          onYes={() => {
            setConfirm(false);
            void act(name, () => dockerClient.removeImage(image.repository ? name : image.id));
          }}
        />
      )}
    </li>
  );
}

const STATE: Record<string, string> = {
  running: "działa",
  exited: "zatrzymany",
  created: "utworzony",
  paused: "wstrzymany",
  restarting: "uruchamia się ponownie",
  dead: "uszkodzony",
};

function ContainerRow({ container: c }: { container: DockerContainer }) {
  const { act, busy } = useDockerStore();
  const [confirm, setConfirm] = useState(false);
  const projectDir = useAgentsStore((s) => s.projectDir);
  const host = useDockerStore((s) => s.source);
  const hasProfile = useProfilesStore((s) =>
    s.profiles.some((p) => p.kind === "container" && p.container?.name === c.name && (p.container.host ?? null) === host),
  );
  const terminal = () =>
    void openContainerTerminal(c.name, { leverframe: c.leverframe, projectDir, host }).catch((e: unknown) =>
      useDockerStore.setState({ error: String(e) }),
    );
  const running = c.state === "running";
  const working = !!busy[c.name];
  const run = (action: "start" | "stop" | "restart") => void act(c.name, () => dockerClient.containerAction(c.name, action));
  return (
    <li aria-label={`Kontener ${c.name}`} className="rounded hover:bg-lf-hover">
      <div className="flex items-center gap-1 px-1 py-0.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${running ? "bg-lf-accent" : "bg-lf-subtle"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lf-fg">
            {c.name}
            {c.leverframe && <span className="ml-1 rounded bg-lf-accent/20 px-1 text-[10px] text-lf-accent">agenci</span>}
          </span>
          <span className="block truncate text-[11px] text-lf-subtle" title={c.status}>
            {working ? "…" : (STATE[c.state] ?? c.state)} · <span className="font-mono">{c.image}</span>
          </span>
        </span>
        {running ? (
          <>
            <button type="button" aria-label={`Zatrzymaj ${c.name}`} title="Zatrzymaj" className={iconButton} disabled={working} onClick={() => run("stop")}>
              <span className="codicon codicon-debug-stop" aria-hidden />
            </button>
            <button type="button" aria-label={`Uruchom ponownie ${c.name}`} title="Uruchom ponownie" className={iconButton} disabled={working} onClick={() => run("restart")}>
              <span className="codicon codicon-debug-restart" aria-hidden />
            </button>
          </>
        ) : (
          <button type="button" aria-label={`Uruchom ${c.name}`} title="Uruchom" className={iconButton} disabled={working} onClick={() => run("start")}>
            <span className="codicon codicon-play" aria-hidden />
          </button>
        )}
        <button type="button" aria-label={`Terminal w ${c.name}`} title="Terminal w kontenerze" className={iconButton} disabled={working} onClick={terminal}>
          <span className="codicon codicon-terminal" aria-hidden />
        </button>
        {!c.leverframe && !hasProfile && (
          <button
            type="button"
            aria-label={`Dodaj ${c.name} jako profil`}
            title="Dodaj jako profil terminala"
            className={iconButton}
            onClick={() => void addContainerProfile(c.name, host).catch((e: unknown) => useDockerStore.setState({ error: String(e) }))}
          >
            <span className="codicon codicon-add" aria-hidden />
          </button>
        )}
        <button type="button" aria-label={`Logi ${c.name}`} title="Logi kontenera" className={iconButton} onClick={() => openContainerLogs(c.name)}>
          <span className="codicon codicon-output" aria-hidden />
        </button>
        <button type="button" aria-label={`Usuń kontener ${c.name}`} title="Usuń kontener" className={iconButton} disabled={working} onClick={() => setConfirm(true)}>
          <span className="codicon codicon-trash" aria-hidden />
        </button>
      </div>
      {confirm && (
        <Confirm
          question={running ? `Kontener ${c.name} działa. Zatrzymać go i usunąć?` : `Usunąć kontener ${c.name}? (wolumeny zostają)`}
          onNo={() => setConfirm(false)}
          onYes={() => {
            setConfirm(false);
            void act(c.name, () => dockerClient.removeContainer(c.name, running)).then(
              // Its detected profile goes away with it.
              () => c.leverframe && void useProfilesStore.getState().refresh(),
            );
          }}
        />
      )}
    </li>
  );
}

function VolumeRow({ name }: { name: string }) {
  const { act, busy } = useDockerStore();
  const [confirm, setConfirm] = useState(false);
  return (
    <li aria-label={`Wolumen ${name}`} className="rounded hover:bg-lf-hover">
      <div className="flex items-center gap-1 px-1 py-0.5">
        <span className="codicon codicon-database text-lf-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-lf-fg" title={name}>
          {name}
        </span>
        <button type="button" aria-label={`Usuń wolumen ${name}`} title="Usuń wolumen" className={iconButton} disabled={busy[name]} onClick={() => setConfirm(true)}>
          <span className="codicon codicon-trash" aria-hidden />
        </button>
      </div>
      {confirm && (
        <Confirm
          question={`Usunąć wolumen ${name}? Logowania agentów z niego przepadną.`}
          onNo={() => setConfirm(false)}
          onYes={() => {
            setConfirm(false);
            void act(name, () => dockerClient.removeVolume(name));
          }}
        />
      )}
    </li>
  );
}

function JobCard({ job }: { job: DockerJob }) {
  const { cancelJob, dismissJob } = useDockerStore();
  const last = job.lines[job.lines.length - 1];
  return (
    <li aria-label={job.title} className={`rounded border p-1.5 ${job.done && !job.ok ? "border-lf-danger/50" : "border-lf-border"}`}>
      <div className="flex items-center gap-1">
        <span
          className={`codicon ${job.done ? (job.ok ? "codicon-check text-lf-accent" : "codicon-error text-lf-danger") : "codicon-loading codicon-modifier-spin text-lf-muted"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-lf-fg">{job.title}</span>
        {job.done ? (
          <button type="button" aria-label="Zamknij" className={iconButton} onClick={() => dismissJob(job.key)}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        ) : (
          <button type="button" className={smallButton} onClick={() => cancelJob(job.key)} disabled={!job.id}>
            Przerwij
          </button>
        )}
      </div>
      <p role="status" className="truncate font-mono text-[11px] text-lf-muted" title={last}>
        {job.done ? (job.ok ? "Gotowe." : job.message) : (last ?? "Uruchamianie…")}
      </p>
      {job.lines.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-[11px] text-lf-subtle">Wyjście ({job.lines.length})</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-lf-muted">{job.lines.join("\n")}</pre>
        </details>
      )}
    </li>
  );
}
