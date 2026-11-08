import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useAgentsStore } from "../../store/agents";
import { useUiStore } from "../../store/ui";
import { openFile } from "../../workbench/commands";
import { folderName } from "../agents/agentsClient";
import { errorMessage, fsClient, type DirEntry } from "../editor/fsClient";

type Children = Record<string, DirEntry[] | "loading" | { error: string }>;

/** Sidebar view: file tree of the project folder (shared with the Agents panel). */
export function FilesView() {
  const projectDir = useAgentsStore((s) => s.projectDir);
  const load = useAgentsStore((s) => s.load);
  const setProjectDir = useAgentsStore((s) => s.setProjectDir);
  const openQuick = useUiStore((s) => s.setQuickOpen);
  const [children, setChildren] = useState<Children>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
    void fetchDir(projectDir);
  }, [projectDir, fetchDir]);

  if (!isTauri()) {
    return <Placeholder icon="files" title="Pliki" children="Drzewo plików jest dostępne w aplikacji desktopowej." />;
  }

  const pickFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: projectDir ?? undefined });
    if (typeof picked === "string") await setProjectDir(picked);
  };

  const refresh = () => {
    if (!projectDir) return;
    void fetchDir(projectDir);
    expanded.forEach((d) => void fetchDir(d));
  };

  const toggle = (dir: string) => {
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
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-1 px-3 pb-1">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-lf-fg" title={projectDir}>
          {folderName(projectDir)}
        </span>
        <ToolbarButton icon="go-to-file" label="Szybkie otwieranie (Ctrl+P)" onClick={() => openQuick(true)} />
        <ToolbarButton icon="folder-opened" label="Otwórz inny folder…" onClick={() => void pickFolder()} />
        <ToolbarButton icon="refresh" label="Odśwież" onClick={refresh} />
        <ToolbarButton icon="collapse-all" label="Zwiń wszystko" onClick={() => setExpanded(new Set())} />
      </div>
      <Tree dir={projectDir} depth={0} nodes={children} expanded={expanded} toggle={toggle} />
    </div>
  );
}

function Tree(props: { dir: string; depth: number; nodes: Children; expanded: Set<string>; toggle: (d: string) => void }) {
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
            <button
              type="button"
              onClick={() => (e.isDir ? props.toggle(e.path) : openFile(e.path))}
              title={e.path}
              className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[13px] text-lf-fg hover:bg-lf-hover"
              style={pad}
            >
              <span
                className={`codicon codicon-${e.isDir ? (open ? "chevron-down" : "chevron-right") : "blank"} shrink-0 text-lf-muted`}
                aria-hidden
              />
              <span className={`codicon codicon-${e.isDir ? (open ? "folder-opened" : "folder") : "file"} shrink-0 text-lf-muted`} aria-hidden />
              <span className="truncate">{e.name}</span>
            </button>
            {e.isDir && open && <Tree {...props} dir={e.path} depth={props.depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function ToolbarButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded p-1 text-lf-muted hover:bg-lf-hover hover:text-lf-fg">
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}
