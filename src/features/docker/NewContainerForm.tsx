import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAgentsStore } from "../../store/agents";
import { useDockerStore } from "../../store/docker";
import { useProfilesStore } from "../../store/profiles";
import { folderName } from "../agents/agentsClient";
import { dockerClient, type ContainerSpec, type CreatePlan, type DockerImage, imageName } from "./dockerClient";

export const fieldClass =
  "w-full rounded border border-lf-border bg-lf-editor px-2 py-1 text-xs text-lf-fg outline-none placeholder:text-lf-subtle focus:border-lf-accent";

/** A container name from a folder name: `sklep` → `sklep-agenci`. */
export function suggestedName(dir: string | null): string {
  const base = (dir ? folderName(dir) : "leverframe")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  return `${base || "leverframe"}-agenci`;
}

/** `KEY=value` lines → variables (lines without `=` are ignored by the form's check below). */
export function parseEnv(text: string): { name: string; value: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? { name: l, value: "" } : { name: l.slice(0, i).trim(), value: l.slice(i + 1) };
    });
}

/**
 * "Nowy kontener": a container for agents from an image, with the project folder mounted as
 * /workspace and a volume for the agents' logins. The `docker run` it will run, and warnings,
 * come from the backend and are shown before it is created.
 */
export function NewContainerForm({ image, onDone }: { image: DockerImage; onDone: () => void }) {
  const projectDir = useAgentsStore((s) => s.projectDir);
  const act = useDockerStore((s) => s.act);
  const ids = { name: useId(), dir: useId(), home: useId(), env: useId(), ports: useId(), net: useId(), user: useId() };
  const [dir, setDir] = useState<string | null>(projectDir);
  const [name, setName] = useState(() => suggestedName(projectDir));
  const [homeVolume, setHomeVolume] = useState(true);
  const [homeDir, setHomeDir] = useState(image.leverframe ? "/home/agent" : "/root");
  const [env, setEnv] = useState("");
  const [ports, setPorts] = useState("");
  const [network, setNetwork] = useState("");
  const [user, setUser] = useState("");
  const [plan, setPlan] = useState<CreatePlan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [creating, setCreating] = useState(false);
  // Warnings the user accepted; new ones must be accepted again.
  const acceptedFor = useRef("");

  const spec: ContainerSpec = {
    image: imageName(image),
    name: name.trim(),
    projectDir: dir,
    homeVolume,
    homeDir: homeDir.trim(),
    env: parseEnv(env),
    ports: ports.split(/[\s,]+/).filter(Boolean),
    network: network.trim() || null,
    user: user.trim() || null,
  };
  const specKey = JSON.stringify(spec);

  // The backend checks the form and builds the command (debounced while typing).
  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      dockerClient.createPlan(JSON.parse(specKey) as ContainerSpec).then(
        (p) => {
          if (!current) return;
          setPlan(p);
          setProblem(null);
          if (p.warnings.join("\n") !== acceptedFor.current) setAccepted(false);
        },
        (e: unknown) => current && (setPlan(null), setProblem(String(e))),
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [specKey]);

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dir ?? undefined });
    if (typeof picked === "string") {
      if (name === suggestedName(dir)) setName(suggestedName(picked));
      setDir(picked);
    }
  };

  const createIt = async () => {
    setCreating(true);
    const ok = await act(name, () => dockerClient.create(spec));
    setCreating(false);
    if (ok) {
      // The new container is a detected profile: "Terminale" and "Agenci" list it.
      void useProfilesStore.getState().refresh();
      onDone();
    }
  };

  const needsAccept = (plan?.warnings.length ?? 0) > 0;
  const label = "text-[11px] font-semibold text-lf-fg";
  return (
    <form
      aria-label="Nowy kontener"
      className="flex flex-col gap-2 rounded border border-lf-border bg-lf-elevated p-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (plan && (!needsAccept || accepted)) void createIt();
      }}
    >
      <p className="font-semibold text-lf-fg">
        Nowy kontener z <span className="font-mono">{imageName(image)}</span>
      </p>
      <label htmlFor={ids.name} className={label}>
        Nazwa
      </label>
      <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} className={`${fieldClass} font-mono`} />

      <label htmlFor={ids.dir} className={label}>
        Folder projektu (w kontenerze: /workspace)
      </label>
      <div className="flex gap-1">
        <input id={ids.dir} value={dir ?? ""} readOnly placeholder="bez folderu" title={dir ?? undefined} className={`${fieldClass} min-w-0 flex-1 font-mono`} />
        <button type="button" onClick={() => void pickDir()} className="shrink-0 rounded border border-lf-border px-2 text-lf-fg hover:bg-lf-hover">
          Wybierz…
        </button>
        {dir && (
          <button type="button" aria-label="Bez folderu projektu" onClick={() => setDir(null)} className="shrink-0 rounded px-1 text-lf-muted hover:bg-lf-hover">
            <span className="codicon codicon-close" aria-hidden />
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 text-lf-fg">
        <input type="checkbox" checked={homeVolume} onChange={(e) => setHomeVolume(e.target.checked)} />
        Wolumen na katalog domowy (logowania agentów przetrwają usunięcie kontenera)
      </label>
      {homeVolume && (
        <>
          <label htmlFor={ids.home} className={label}>
            Katalog domowy w kontenerze
          </label>
          <input id={ids.home} value={homeDir} onChange={(e) => setHomeDir(e.target.value)} className={`${fieldClass} font-mono`} />
        </>
      )}

      <details>
        <summary className="cursor-pointer select-none text-lf-muted">Więcej: zmienne, porty, sieć, użytkownik</summary>
        <div className="mt-1 flex flex-col gap-1">
          <label htmlFor={ids.env} className={label}>
            Zmienne środowiskowe (NAZWA=wartość, jedna w linii)
          </label>
          <textarea id={ids.env} value={env} onChange={(e) => setEnv(e.target.value)} rows={2} className={`${fieldClass} font-mono`} />
          <label htmlFor={ids.ports} className={label}>
            Porty (np. 8080:80, 5173)
          </label>
          <input id={ids.ports} value={ports} onChange={(e) => setPorts(e.target.value)} className={`${fieldClass} font-mono`} />
          <label htmlFor={ids.net} className={label}>
            Sieć Dockera
          </label>
          <input id={ids.net} value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="bridge" className={`${fieldClass} font-mono`} />
          <label htmlFor={ids.user} className={label}>
            Użytkownik
          </label>
          <input id={ids.user} value={user} onChange={(e) => setUser(e.target.value)} placeholder="jak w obrazie" className={`${fieldClass} font-mono`} />
        </div>
      </details>

      {problem && (
        <p role="alert" className="text-lf-danger">
          {problem}
        </p>
      )}
      {plan && (
        <div aria-label="Polecenie">
          <p className={label}>Leverframe uruchomi:</p>
          <code className="block whitespace-pre-wrap break-all rounded bg-lf-bg p-1 font-mono text-[11px] text-lf-fg">{plan.command}</code>
          {plan.volume && <p className="mt-0.5 text-[11px] text-lf-subtle">Wolumen {plan.volume} zostanie utworzony, jeśli go nie ma.</p>}
        </div>
      )}
      {plan?.warnings.map((w) => (
        <p key={w} className="rounded border border-lf-accent/50 p-1 text-lf-fg">
          <span className="codicon codicon-warning align-middle text-lf-accent" aria-hidden /> {w}
        </p>
      ))}
      {needsAccept && (
        <label className="flex items-center gap-2 text-lf-fg">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => {
              acceptedFor.current = e.target.checked ? (plan?.warnings.join("\n") ?? "") : "";
              setAccepted(e.target.checked);
            }}
          />
          Rozumiem, utwórz mimo to
        </label>
      )}
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={!plan || creating || (needsAccept && !accepted)}
          className="rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {creating ? "Tworzenie…" : "Utwórz i uruchom"}
        </button>
        <button type="button" onClick={onDone} className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover">
          Anuluj
        </button>
      </div>
    </form>
  );
}
