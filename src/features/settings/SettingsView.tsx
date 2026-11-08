import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_FONT_MONO, DEFAULT_FONT_SIZE, useUiStore } from "../../store/ui";
import { useSettingsStore, type ThemeSetting } from "../../store/settings";
import { isTauri } from "../../lib/tauri";
import { openFile } from "../../workbench/commands";

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: "dark", label: "Ciemny" },
  { value: "light", label: "Jasny" },
  { value: "system", label: "Jak w systemie" },
];

const inputClass =
  "rounded border border-lf-border bg-lf-editor px-2 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent";

/** Settings stored in settings.json (also editable as a file). */
export function SettingsView() {
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const theme = useUiStore((s) => s.theme);
  const settingsError = useSettingsStore((s) => s.error);
  const update = useSettingsStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  const fontId = useId();
  const sizeId = useId();
  const themeId = useId();

  const save = async (key: "theme" | "fontFamily" | "fontSize", value: unknown) => {
    // Apply immediately, persist in settings.json (in the browser there is no file).
    const ui = useUiStore.getState();
    if (key === "theme") ui.setTheme(value as ThemeSetting);
    if (key === "fontFamily") ui.setFontMono(String(value));
    if (key === "fontSize") ui.setFontSize(Number(value));
    setError(await update(key, value));
  };

  const openSettingsFile = async () => {
    try {
      openFile(await invoke<string>("settings_ensure_file"));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <form className="flex flex-col gap-4 px-4 py-2" onSubmit={(e) => e.preventDefault()}>
      {settingsError && (
        <p role="alert" className="rounded border border-lf-danger/50 p-2 text-[11px] leading-relaxed text-lf-danger">
          {settingsError}. Popraw plik – do tego czasu zmiany nie są zapisywane.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={themeId} className="text-xs font-semibold text-lf-fg">
          Motyw
        </label>
        <select id={themeId} value={theme} onChange={(e) => void save("theme", e.target.value)} className={inputClass}>
          {THEMES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={fontId} className="text-xs font-semibold text-lf-fg">
          Czcionka terminala i edytora
        </label>
        <input
          id={fontId}
          key={fontMono}
          defaultValue={fontMono}
          onBlur={(e) => e.target.value.trim() && e.target.value !== fontMono && void save("fontFamily", e.target.value.trim())}
          className={`${inputClass} font-mono`}
        />
        <span className="text-[11px] text-lf-subtle">Domyślnie: {DEFAULT_FONT_MONO}</span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={sizeId} className="text-xs font-semibold text-lf-fg">
          Rozmiar czcionki (px)
        </label>
        <input
          id={sizeId}
          type="number"
          min={8}
          max={32}
          value={fontSize}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isInteger(n) && n >= 8 && n <= 32) void save("fontSize", n);
          }}
          className={`${inputClass} w-24`}
        />
        <span className="text-[11px] text-lf-subtle">Domyślnie: {DEFAULT_FONT_SIZE}</span>
      </div>
      {error && <p className="text-[11px] text-lf-danger">{error}</p>}
      {isTauri() && (
        <div className="flex flex-col gap-1 border-t border-lf-border pt-3">
          <button type="button" onClick={() => void openSettingsFile()} className="flex items-center gap-1 self-start text-xs text-lf-accent hover:underline">
            <span className="codicon codicon-json" aria-hidden />
            Otwórz settings.json
          </button>
          <p className="text-[11px] leading-relaxed text-lf-subtle">
            W pliku ustawisz też skróty klawiszowe (<code className="font-mono">keybindings</code>), profil domyślny i nagrywanie sesji.
            Zmiany obowiązują po zapisaniu pliku (Ctrl+S).
          </p>
        </div>
      )}
    </form>
  );
}
