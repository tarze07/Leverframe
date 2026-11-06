import { useEffect, useRef, useState } from "react";
import { useProfilesStore } from "../../store/profiles";
import { openProfile } from "../../workbench/commands";
import { groupProfiles, KIND_LABELS, profileIcon } from "./profilesClient";

/** Chevron next to "+" in the terminal panel: pick a profile for the new terminal. */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const profiles = useProfilesStore((s) => s.profiles);
  const defaultId = useProfilesStore((s) => s.defaultProfileId);
  const load = useProfilesStore((s) => s.load);

  useEffect(() => {
    if (!open) return;
    void load();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="Wybierz profil terminala"
        aria-label="Wybierz profil terminala"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
      >
        <span className="codicon codicon-chevron-down" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 max-h-80 w-64 overflow-auto rounded border border-lf-border bg-lf-elevated py-1 normal-case tracking-normal shadow-xl"
        >
          {profiles.length === 0 && <p className="px-3 py-1 text-xs font-normal text-lf-subtle">Brak profili</p>}
          {groupProfiles(profiles).map(([kind, list]) => (
            <div key={kind}>
              <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase text-lf-subtle">{KIND_LABELS[kind]}</p>
              {list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    openProfile(p.id);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs font-normal text-lf-fg hover:bg-lf-hover"
                >
                  <span className={`codicon codicon-${profileIcon(p)} text-lf-muted`} aria-hidden />
                  <span className="truncate">{p.name}</span>
                  {p.id === defaultId && <span className="ml-auto text-[10px] text-lf-accent">domyślny</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
