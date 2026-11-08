import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "./ui";

export type ThemeSetting = "dark" | "light" | "system";

export interface SettingsSnapshot {
  path: string;
  values: Record<string, unknown>;
  error: string | null;
}

interface SettingsStore {
  path: string | null;
  values: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** Validated by the backend; returns an error message or null. */
  update: (key: "theme" | "fontFamily" | "fontSize" | "keybindings", value: unknown) => Promise<string | null>;
}

/** Pushes values that drive the UI into the UI store. */
function apply(values: Record<string, unknown>) {
  const ui = useUiStore.getState();
  const theme = values.theme;
  ui.setTheme(theme === "light" || theme === "system" ? theme : "dark");
  // Fonts: only when set in the file (otherwise the last choice in this app stays).
  if (typeof values.fontFamily === "string") ui.setFontMono(values.fontFamily);
  if (typeof values.fontSize === "number") ui.setFontSize(values.fontSize);
}

export const useSettingsStore = create<SettingsStore>()((set) => {
  const accept = (s: SettingsSnapshot) => {
    set({ path: s.path, values: s.values, error: s.error, loaded: true });
    if (!s.error) apply(s.values);
  };
  return {
    path: null,
    values: {},
    error: null,
    loaded: false,
    load: async () => {
      if (!isTauri()) return;
      try {
        accept(await invoke<SettingsSnapshot>("settings_read"));
      } catch (e) {
        set({ error: String(e), loaded: true });
      }
    },
    update: async (key, value) => {
      if (!isTauri()) return null;
      try {
        accept(await invoke<SettingsSnapshot>("settings_update", { key, value }));
        return null;
      } catch (e) {
        return String(e);
      }
    },
  };
});

/** User keybinding overrides from settings.json (`null` disables a default). */
export function keybindingOverrides(values: Record<string, unknown>): Record<string, string | null> {
  const kb = values.keybindings;
  if (!kb || typeof kb !== "object") return {};
  return Object.fromEntries(
    Object.entries(kb as Record<string, unknown>).filter(([, v]) => typeof v === "string" || v === null),
  ) as Record<string, string | null>;
}
