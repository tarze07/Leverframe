import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** True when running inside the Tauri webview (false in plain browser / tests). */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
}

export async function getAppInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null;
  return invoke<AppInfo>("app_info");
}

export const windowControls = {
  minimize: () => (isTauri() ? getCurrentWindow().minimize() : Promise.resolve()),
  toggleMaximize: () => (isTauri() ? getCurrentWindow().toggleMaximize() : Promise.resolve()),
  close: () => (isTauri() ? getCurrentWindow().close() : Promise.resolve()),
};
