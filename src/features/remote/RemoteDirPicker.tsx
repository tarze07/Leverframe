import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Folders of a folder on another computer (backend `remote_list_dirs`). */
export interface RemoteDirs {
  path: string;
  parent: string | null;
  dirs: string[];
  truncated: boolean;
}

export const remoteDirsClient = {
  list: (profileId: string, path: string, showHidden: boolean) =>
    invoke<RemoteDirs>("remote_list_dirs", { profileId, path, showHidden }),
  mkdir: (profileId: string, parent: string, name: string) =>
    invoke<RemoteDirs>("remote_make_dir", { profileId, parent, name }),
};

const join = (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

/**
 * Browses the folders of an SSH host or a container through its profile (#100): from `start`
 * (the home folder when empty), up and into folders, a path typed by hand, a new folder.
 * "Wybierz ten folder" gives the absolute path.
 */
export function RemoteDirPicker(props: { profileId: string; host: string; start?: string | null; onChoose: (path: string) => void; onCancel: () => void }) {
  const { profileId } = props;
  const [listing, setListing] = useState<RemoteDirs | null>(null);
  const [typed, setTyped] = useState(props.start ?? "");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  const open = useCallback(
    async (path: string, hidden = showHidden) => {
      setLoading(true);
      setError(null);
      try {
        const l = await remoteDirsClient.list(profileId, path, hidden);
        setListing(l);
        setTyped(l.path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [profileId, showHidden],
  );

  // The first folder (`start`, or home); later ones are opened by the user.
  const start = props.start ?? "";
  useEffect(() => {
    let live = true;
    remoteDirsClient
      .list(profileId, start, false)
      .then(
        (l) => {
          if (!live) return;
          setListing(l);
          setTyped(l.path);
        },
        (e: unknown) => live && setError(String(e)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // Only when the picker opens for a profile, not while the field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const makeDir = async () => {
    if (!listing || !newName?.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const l = await remoteDirsClient.mkdir(profileId, listing.path, newName.trim());
      setNewName(null);
      setListing(l);
      setTyped(l.path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const button = "rounded px-2 py-0.5 text-[11px] disabled:opacity-50";
  return (
    <div role="dialog" aria-label={`Wybierz folder na ${props.host}`} className="flex flex-col gap-1 rounded border border-lf-border bg-lf-editor p-2 text-xs">
      <p className="text-[11px] font-semibold text-lf-fg">Folder na {props.host}</p>
      {/* No <form>: the picker may sit inside another form ("Nowy kontener"); forms cannot nest. */}
      <div className="flex gap-1">
        <button
          type="button"
          title="W górę"
          aria-label="W górę"
          disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && void open(listing.parent)}
          className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg disabled:opacity-40"
        >
          <span className="codicon codicon-arrow-up" aria-hidden />
        </button>
        <input
          aria-label="Ścieżka"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void open(typed.trim());
            }
          }}
          placeholder="~ (katalog domowy)"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-lf-border bg-lf-bg px-1.5 py-1 font-mono text-[11px] text-lf-fg outline-none focus:border-lf-accent"
        />
        <button type="button" disabled={loading} onClick={() => void open(typed.trim())} className={`${button} border border-lf-border text-lf-fg hover:bg-lf-hover`}>
          Przejdź
        </button>
      </div>

      {error && (
        <p role="alert" className="text-[11px] text-lf-danger">
          {error}
        </p>
      )}
      <ul aria-label="Foldery" aria-busy={loading} className="max-h-56 overflow-auto rounded border border-lf-border">
        {loading && !listing && <li className="px-2 py-1 text-lf-muted">Wczytywanie…</li>}
        {listing?.dirs.map((d) => (
          <li key={d}>
            <button
              type="button"
              disabled={loading}
              onClick={() => void open(join(listing.path, d))}
              title={join(listing.path, d)}
              className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-lf-fg hover:bg-lf-hover"
            >
              <span className="codicon codicon-folder text-lf-muted" aria-hidden />
              <span className="truncate">{d}</span>
            </button>
          </li>
        ))}
        {listing && listing.dirs.length === 0 && <li className="px-2 py-1 text-lf-subtle">(brak podfolderów)</li>}
        {listing?.truncated && <li className="px-2 py-1 text-[11px] text-lf-subtle">Pokazano tylko część folderów – wpisz ścieżkę.</li>}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-lf-muted">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => {
              setShowHidden(e.target.checked);
              if (listing) void open(listing.path, e.target.checked);
            }}
          />
          Ukryte foldery
        </label>
        {newName === null ? (
          <button type="button" disabled={!listing || loading} onClick={() => setNewName("")} className={`${button} text-lf-muted hover:text-lf-fg`}>
            Nowy folder…
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              aria-label="Nazwa nowego folderu"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewName(null);
                if (e.key === "Enter") {
                  e.preventDefault();
                  void makeDir();
                }
              }}
              className="w-32 rounded border border-lf-border bg-lf-bg px-1.5 py-0.5 font-mono text-[11px] text-lf-fg outline-none focus:border-lf-accent"
            />
            <button type="button" disabled={!newName.trim() || loading} onClick={() => void makeDir()} className={`${button} border border-lf-border text-lf-fg`}>
              Utwórz
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1">
        <button
          type="button"
          disabled={!listing || loading}
          onClick={() => listing && props.onChoose(listing.path)}
          className={`${button} bg-lf-accent text-lf-accent-fg`}
          title={listing?.path}
        >
          Wybierz ten folder
        </button>
        <button type="button" onClick={props.onCancel} className={`${button} text-lf-muted hover:text-lf-fg`}>
          Anuluj
        </button>
      </div>
    </div>
  );
}
