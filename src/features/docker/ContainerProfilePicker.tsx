import { useEffect, useState } from "react";
import { useProfilesStore } from "../../store/profiles";
import { dockerClient, type DockerContainer } from "./dockerClient";
import { addContainerProfile } from "./containerTerminal";

/** In "Terminale": Docker containers without a profile, to add as terminal profiles. */
export function ContainerProfilePicker({ onDone }: { onDone: () => void }) {
  const profiles = useProfilesStore((s) => s.profiles);
  const [containers, setContainers] = useState<DockerContainer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const info = await dockerClient.info();
      if (!info.running) throw new Error(info.message ?? "Docker nie działa");
      return dockerClient.containers();
    })().then(
      (list) => current && setContainers(list),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  const free = (containers ?? []).filter((c) => !profiles.some((p) => p.kind === "container" && p.container?.name === c.name));
  const add = (name: string) =>
    void addContainerProfile(name).then(onDone, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <section aria-label="Dodaj kontener" className="flex flex-col gap-2 px-3 pb-4 text-xs">
      <p className="font-semibold text-lf-fg">Kontener jako profil terminala</p>
      <p className="text-[11px] leading-relaxed text-lf-subtle">
        Terminal profilu otwiera powłokę w kontenerze (docker exec) i uruchamia zatrzymany kontener. Kontenery utworzone w widoku „Kontenery” mają profil od
        razu.
      </p>
      {error && (
        <p role="alert" className="text-lf-danger">
          {error}
        </p>
      )}
      {containers === null && !error && <p className="text-lf-subtle">Wczytywanie kontenerów…</p>}
      {containers && free.length === 0 && <p className="text-lf-subtle">Wszystkie kontenery mają już profile.</p>}
      <ul aria-label="Kontenery bez profilu" className="flex flex-col gap-0.5">
        {free.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-lf-hover">
            <span className="codicon codicon-package text-lf-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lf-fg">{c.name}</span>
              <span className="block truncate font-mono text-[11px] text-lf-subtle">{c.image}</span>
            </span>
            <button type="button" onClick={() => add(c.name)} className="shrink-0 rounded border border-lf-border px-2 text-lf-fg hover:bg-lf-hover">
              Dodaj
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onDone} className="self-start rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover">
        Gotowe
      </button>
    </section>
  );
}
