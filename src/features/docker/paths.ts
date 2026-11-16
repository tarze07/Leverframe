import { joinPath } from "../editor/fsClient";
import type { ContainerMount } from "./dockerClient";

/** Docker Desktop reports bind sources on Windows as `/run/desktop/mnt/host/c/…` (or `C:\…`). */
function sourceOnThisMachine(source: string, windows: boolean): string {
  const m = /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-zA-Z])\/(.*)$/.exec(source);
  if (m && windows) return `${m[1].toUpperCase()}:\\${m[2].replaceAll("/", "\\")}`;
  return source;
}

/**
 * A path in a container as a file of this machine, when a bind mount contains it (the deepest
 * one wins); `null` when the file exists only in the container. Relative paths are relative to
 * `cwd` (in the container).
 */
export function hostPath(mounts: ContainerMount[], path: string, cwd: string | null, windows = false): string | null {
  const full = path.startsWith("/") || !cwd ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const parts: string[] = [];
  for (const p of full.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  const normal = `/${parts.join("/")}`;
  const best = mounts
    .filter((m) => m.kind === "bind")
    .map((m) => ({ m, dest: m.destination.replace(/\/+$/, "") || "/" }))
    .filter(({ dest }) => dest === "/" || normal === dest || normal.startsWith(`${dest}/`))
    .sort((a, b) => b.dest.length - a.dest.length)[0];
  if (!best) return null;
  const rest = best.dest === "/" ? normal.slice(1) : normal.slice(best.dest.length + 1);
  const base = sourceOnThisMachine(best.m.source, windows);
  return rest ? joinPath(base, rest) : base;
}
