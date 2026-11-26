import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { onFilesChanged } from "../../lib/fileEvents";
import { useAgentsStore } from "../../store/agents";
import { useUiStore } from "../../store/ui";
import { closeEditorsUnder, openFile } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { errorMessage, fsClient, type DirEntry } from "../editor/fsClient";
import { copyPath, copyShortcut, PATH_LABELS, type PathKind } from "./copyPath";

type Children = Record<string, DirEntry[] | "loading" | { error: string }>;

/** Sidebar view: file tree of the project folder (shared with the Agents panel). */
export function FilesView() {
  const projectDir = useAgentsStore((s) => s.projectDir);
  const recentDirs = useAgentsStore((s) => s.recentDirs);
  const [folderMenu, setFolderMenu] = useState(false);
  const load = useAgentsStore((s) => s.load);
  const setProjectDir = useAgentsStore((s) => s.setProjectDir);
  const openQuick = useUiStore((s) => s.setQuickOpen);
  const [children, setChildren] = useState<Children>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The folder new files and folders go to (the last folder clicked; the project folder at first).
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [deleting, setDeleting] = useState<DirEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The menu of a file or folder (#121), and what was copied.
  const [menu, setMenu] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchDir = useCallback(async (dir: string) => {
    setChildren((c) => ({ ...c, [dir]: c[dir] && c[dir] !== "loading" ? c[dir] : "loading" }));
    try {
      const entries = await fsClient.listDir(dir);
      setChildren((c) => ({ ...c, [dir]: entries }));
    } catch (e) {
      setChildren((c) => ({ ...c, [dir]: { error: errorMessage(e) } }));
    }
  }, []);

  useEffect(() => {
    if (!projectDir) return;
    setExpanded(new Set());
    setChildren({});
    setSelected(null);
    void fetchDir(projectDir);
  }, [projectDir, fetchDir]);

  // Files written by an agent (or other tools in the app) appear without a manual refresh.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(
    () =>
      onFilesChanged(() => {
        if (!projectDir) return;
        void fetchDir(projectDir);
        expandedRef.current.forEach((d) => void fetchDir(d));
      }),
    [projectDir, fetchDir],
  );

  if (!isTauri()) {
    return <Placeholder icon="files" title="Pliki" children="Drzewo plików jest dostępne w aplikacji desktopowej." />;
  }

  const chooseFolder = async (dir: string) => {
    setFolderMenu(false);
    setActionError(null);
    try {
      await setProjectDir(dir);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const pickFolder = async () => {
    setFolderMenu(false);
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: projectDir ?? undefined });
    if (typeof picked === "string") await setProjectDir(picked);
  };

  const refresh = () => {
    if (!projectDir) return;
    void fetchDir(projectDir);
    expanded.forEach((d) => void fetchDir(d));
  };

  const toggle = (dir: string) => {
    setSelected(dir);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void fetchDir(dir);
      }
      return next;
    });
  };

  if (!projectDir) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <p className="text-xs text-lf-muted">Nie wybrano folderu projektu.</p>
        <button type="button" onClick={() => void pickFolder()} className="rounded bg-lf-accent px-3 py-1 text-xs text-lf-accent-fg">
          Otwórz folder…
        </button>
        {recentDirs.length > 0 && (
          <div className="flex w-full flex-col gap-1 text-left">
            <span className="text-[11px] text-lf-muted">Ostatnio otwierane</span>
            <RecentFolders dirs={recentDirs} onChoose={(d) => void chooseFolder(d)} />
          </div>
        )}
      </div>
    );
  }

  const target = selected ?? projectDir;
  const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "") || projectDir;
  const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);

  const create = async (kind: "file" | "dir", name: string) => {
    setActionError(null);
    try {
      const path = await fsClient.create(target, name, kind === "dir");
      setCreating(null);
      // Show it: the target folder and the folders made on the way open and are read again.
      const opened = new Set([target]);
      for (let dir = parentOf(path); dir.length > target.length && isUnder(dir, target); dir = parentOf(dir)) opened.add(dir);
      setExpanded((prev) => new Set([...prev, ...opened]));
      opened.forEach((d) => void fetchDir(d));
      if (kind === "file") openFile(path);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const copy = (kind: PathKind, path: string) => {
    setMenu(null);
    setActionError(null);
    copyPath(kind, path).then(
      (text) => setNotice(`Skopiowano: ${text}`),
      (e: unknown) => setActionError(`Nie można skopiować do schowka: ${errorMessage(e)}`),
    );
  };

  const remove = async (entry: DirEntry, permanently: boolean) => {
    setActionError(null);
    try {
      await fsClient.remove(entry.path, permanently);
      setDeleting(null);
      closeEditorsUnder(entry.path);
      if (selected && isUnder(selected, entry.path)) setSelected(null);
      setExpanded((prev) => new Set([...prev].filter((d) => !isUnder(d, entry.path))));
      void fetchDir(parentOf(entry.path));
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-1 px-3 pb-1">
        <button
          type="button"
          title={`${projectDir} – kliknij, aby otworzyć inny folder`}
          aria-label="Zmień folder projektu"
          aria-expanded={folderMenu}
          onClick={() => setFolderMenu((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-semibold text-lf-fg hover:bg-lf-hover"
        >
          <span className="truncate">{folderName(projectDir)}</span>
          <span className={`codicon codicon-chevron-${folderMenu ? "up" : "down"} shrink-0 text-lf-muted`} aria-hidden />
        </button>
        <ToolbarButton icon="new-file" label="Nowy plik…" onClick={() => (setCreating("file"), setActionError(null))} />
        <ToolbarButton icon="new-folder" label="Nowy folder…" onClick={() => (setCreating("dir"), setActionError(null))} />
        <ToolbarButton icon="go-to-file" label="Szybkie otwieranie (Ctrl+P)" onClick={() => openQuick(true)} />
        <ToolbarButton icon="refresh" label="Odśwież" onClick={refresh} />
        <ToolbarButton icon="collapse-all" label="Zwiń wszystko" onClick={() => setExpanded(new Set())} />
      </div>
      {folderMenu && (
        <div className="mx-3 mb-2 flex flex-col gap-1 rounded border border-lf-border bg-lf-editor p-1">
          <button
            type="button"
            onClick={() => void pickFolder()}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-lf-fg hover:bg-lf-hover"
          >
            <span className="codicon codicon-folder-opened text-lf-muted" aria-hidden />
            Otwórz folder…
          </button>
          <button
            type="button"
            onClick={() => (setFolderMenu(false), copy("absolute", projectDir))}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-lf-fg hover:bg-lf-hover"
          >
            <span className="codicon codicon-copy text-lf-muted" aria-hidden />
            Kopiuj ścieżkę folderu projektu
          </button>
          {recentDirs.some((d) => d !== projectDir) && (
            <>
              <span className="px-1.5 pt-1 text-[11px] text-lf-muted">Ostatnio otwierane</span>
              <RecentFolders dirs={recentDirs.filter((d) => d !== projectDir)} onChoose={(d) => void chooseFolder(d)} />
            </>
          )}
        </div>
      )}
      {creating && (
        <NewEntryForm
          key={creating}
          kind={creating}
          folder={target === projectDir ? folderName(projectDir) : target.slice(projectDir.length + 1)}
          onSubmit={(name) => void create(creating, name)}
          onCancel={() => (setCreating(null), setActionError(null))}
        />
      )}
      {actionError && (
        <p role="alert" className="px-3 pb-1 text-[11px] text-lf-danger">
          {actionError}
        </p>
      )}
      {notice && (
        <p role="status" className="truncate px-3 pb-1 text-[11px] text-lf-muted" title={notice}>
          {notice}
        </p>
      )}
      <Tree
        dir={projectDir}
        depth={0}
        nodes={children}
        expanded={expanded}
        toggle={toggle}
        selected={target}
        deleting={deleting}
        onDelete={(e) => (setDeleting(e), setActionError(null), setMenu(null))}
        onConfirmDelete={(e, permanently) => void remove(e, permanently)}
        onCancelDelete={() => setDeleting(null)}
        menu={menu}
        onMenu={(path) => (setMenu(path), setDeleting(null))}
        onCopy={copy}
        onCreateIn={(dir, kind) => (setMenu(null), setSelected(dir), setCreating(kind), setActionError(null))}
      />
    </div>
  );
}

interface TreeProps {
  dir: string;
  depth: number;
  nodes: Children;
  expanded: Set<string>;
  toggle: (d: string) => void;
  /** The folder new entries go to (marked). */
  selected: string;
  deleting: DirEntry | null;
  onDelete: (e: DirEntry) => void;
  onConfirmDelete: (e: DirEntry, permanently: boolean) => void;
  onCancelDelete: () => void;
  /** The entry whose menu is open (its path). */
  menu: string | null;
  onMenu: (path: string | null) => void;
  onCopy: (kind: PathKind, path: string) => void;
  onCreateIn: (dir: string, kind: "file" | "dir") => void;
}

function Tree(props: TreeProps) {
  const state = props.nodes[props.dir];
  const pad = { paddingLeft: 12 + props.depth * 12 };
  if (state === undefined || state === "loading") return <p className="py-0.5 text-[11px] text-lf-subtle" style={pad}>…</p>;
  if ("error" in state) return <p className="py-0.5 text-[11px] text-lf-danger" style={pad}>{state.error}</p>;
  if (state.length === 0) return <p className="py-0.5 text-[11px] text-lf-subtle" style={pad}>(pusty)</p>;
  return (
    <ul role={props.depth === 0 ? "tree" : "group"} aria-label={props.depth === 0 ? "Pliki projektu" : undefined}>
      {state.map((e) => {
        const open = props.expanded.has(e.path);
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.isDir ? open : undefined} aria-label={e.name}>
            <div
              className={`group flex items-center hover:bg-lf-hover ${e.isDir && props.selected === e.path ? "bg-lf-hover/60" : ""}`}
              onContextMenu={(ev) => {
                ev.preventDefault();
                props.onMenu(e.path);
              }}
            >
              <button
                type="button"
                onClick={() => (e.isDir ? props.toggle(e.path) : openFile(e.path))}
                onKeyDown={(ev) => {
                  const kind = copyShortcut(ev);
                  if (kind) {
                    ev.preventDefault();
                    props.onCopy(kind, e.path);
                  }
                }}
                title={e.path}
                className="flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-2 text-left text-[13px] text-lf-fg"
                style={pad}
              >
                <span
                  className={`codicon codicon-${e.isDir ? (open ? "chevron-down" : "chevron-right") : "blank"} shrink-0 text-lf-muted`}
                  aria-hidden
                />
                <span className={`codicon codicon-${e.isDir ? (open ? "folder-opened" : "folder") : "file"} shrink-0 text-lf-muted`} aria-hidden />
                <span className="truncate">{e.name}</span>
              </button>
              <button
                type="button"
                title="Więcej"
                aria-label={`Więcej: ${e.name}`}
                aria-expanded={props.menu === e.path}
                onClick={() => props.onMenu(props.menu === e.path ? null : e.path)}
                className="shrink-0 rounded p-0.5 text-lf-muted opacity-0 hover:text-lf-fg focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
              >
                <span className="codicon codicon-kebab-vertical" aria-hidden />
              </button>
              <button
                type="button"
                title={`Usuń ${e.name}`}
                aria-label={`Usuń ${e.name}`}
                onClick={() => props.onDelete(e)}
                className="mr-1 shrink-0 rounded p-0.5 text-lf-muted opacity-0 hover:text-lf-danger focus:opacity-100 group-hover:opacity-100"
              >
                <span className="codicon codicon-trash" aria-hidden />
              </button>
            </div>
            {props.menu === e.path && <EntryMenu entry={e} pad={pad} {...props} />}
            {props.deleting?.path === e.path && (
              <div role="group" aria-label={`Usuwanie ${e.name}`} className="flex flex-wrap items-center gap-1 py-1 pr-2 text-[11px]" style={pad}>
                <span className="text-lf-fg">{e.isDir ? `Usunąć folder ${e.name} z zawartością?` : `Usunąć ${e.name}?`}</span>
                <button type="button" onClick={() => props.onConfirmDelete(e, false)} className="rounded bg-lf-danger px-2 py-0.5 text-white">
                  Do kosza
                </button>
                <button type="button" onClick={() => props.onConfirmDelete(e, true)} className="rounded border border-lf-danger px-2 py-0.5 text-lf-danger">
                  Usuń na stałe
                </button>
                <button type="button" onClick={props.onCancelDelete} className="px-1 text-lf-muted hover:text-lf-fg">
                  Anuluj
                </button>
              </div>
            )}
            {e.isDir && open && <Tree {...props} dir={e.path} depth={props.depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

/** The menu of a file or folder (#121): copying its path or name, new entries in a folder, delete. */
function EntryMenu(props: TreeProps & { entry: DirEntry; pad: { paddingLeft: number } }) {
  const e = props.entry;
  const item = "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-lf-fg hover:bg-lf-hover";
  return (
    <div
      role="menu"
      aria-label={`${e.isDir ? "Folder" : "Plik"} ${e.name}`}
      className="mb-1 mr-2 flex flex-col rounded border border-lf-border bg-lf-editor p-1"
      style={{ marginLeft: props.pad.paddingLeft }}
      onKeyDown={(ev) => ev.key === "Escape" && props.onMenu(null)}
    >
      {(Object.keys(PATH_LABELS) as PathKind[]).map((kind) => (
        <button key={kind} type="button" role="menuitem" onClick={() => props.onCopy(kind, e.path)} className={item}>
          <span className="codicon codicon-copy text-lf-muted" aria-hidden />
          {PATH_LABELS[kind]}
          {kind !== "name" && <span className="ml-auto pl-2 text-[10px] text-lf-subtle">{kind === "absolute" ? "Shift+Alt+C" : "Ctrl+Shift+Alt+C"}</span>}
        </button>
      ))}
      {e.isDir && (
        <>
          <button type="button" role="menuitem" onClick={() => props.onCreateIn(e.path, "file")} className={item}>
            <span className="codicon codicon-new-file text-lf-muted" aria-hidden />
            Nowy plik tutaj…
          </button>
          <button type="button" role="menuitem" onClick={() => props.onCreateIn(e.path, "dir")} className={item}>
            <span className="codicon codicon-new-folder text-lf-muted" aria-hidden />
            Nowy folder tutaj…
          </button>
        </>
      )}
      <button type="button" role="menuitem" onClick={() => props.onDelete(e)} className={`${item} text-lf-danger`}>
        <span className="codicon codicon-trash" aria-hidden />
        Usuń…
      </button>
      <button type="button" role="menuitem" onClick={() => props.onMenu(null)} className={`${item} text-lf-muted`}>
        Anuluj
      </button>
    </div>
  );
}

/** Recently opened project folders: one click opens one again. */
function RecentFolders({ dirs, onChoose }: { dirs: string[]; onChoose: (dir: string) => void }) {
  return (
    <ul aria-label="Ostatnio otwierane foldery" className="flex flex-col">
      {dirs.map((dir) => (
        <li key={dir}>
          <button
            type="button"
            title={dir}
            onClick={() => onChoose(dir)}
            className="flex w-full min-w-0 items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-lf-hover"
          >
            <span className="shrink-0 text-lf-fg">{folderName(dir)}</span>
            <span className="truncate text-[11px] text-lf-subtle">{dir}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The name of a new file or folder, typed in place; Enter creates, Escape cancels. */
function NewEntryForm(props: { kind: "file" | "dir"; folder: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const label = props.kind === "file" ? `Nowy plik w ${props.folder}` : `Nowy folder w ${props.folder}`;
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-1 px-3 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) props.onSubmit(name);
      }}
    >
      <label className="text-[11px] text-lf-muted">
        {label}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
          placeholder={props.kind === "file" ? "np. notatki.md albo src/nowy.ts" : "np. docs/obrazy"}
          spellCheck={false}
          className="mt-0.5 w-full rounded border border-lf-border bg-lf-bg px-1.5 py-1 font-mono text-[12px] text-lf-fg outline-none focus:border-lf-accent"
        />
      </label>
      <div className="flex gap-1">
        <button type="submit" disabled={!name.trim()} className="rounded bg-lf-accent px-2 py-0.5 text-[11px] text-lf-accent-fg disabled:opacity-50">
          Utwórz
        </button>
        <button type="button" onClick={props.onCancel} className="rounded px-2 py-0.5 text-[11px] text-lf-muted hover:text-lf-fg">
          Anuluj
        </button>
      </div>
    </form>
  );
}

function ToolbarButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg">
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
