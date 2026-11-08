import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface TextFile {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

export interface FileList {
  files: string[];
  truncated: boolean;
}

export type FsError = { kind: "conflict"; message: string; mtime: number } | { kind: "other"; message: string };

export const fsClient = {
  listDir: (path: string) => invoke<DirEntry[]>("fs_list_dir", { path }),
  listFiles: (root: string) => invoke<FileList>("fs_list_files", { root }),
  readText: (path: string) => invoke<TextFile>("fs_read_text", { path }),
  writeText: (path: string, content: string, expectedMtime: number | null) =>
    invoke<number>("fs_write_text", { path, content, expectedMtime }),
};

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export const isConflict = (e: unknown): e is Extract<FsError, { kind: "conflict" }> =>
  !!e && typeof e === "object" && (e as FsError).kind === "conflict";

/** File name from a path with `/` or `\` separators. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Joins a root folder and a `/`-separated relative path using the root's separator. */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}
