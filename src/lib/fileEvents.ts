/** Files changed by something other than the file tree (e.g. an agent): views that list files refresh. */
const EVENT = "leverframe:files-changed";

export function notifyFilesChanged(paths: string[]) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: paths }));
}

export function onFilesChanged(listener: (paths: string[]) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string[]>).detail ?? []);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
