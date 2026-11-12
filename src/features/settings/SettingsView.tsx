import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_FONT_MONO, DEFAULT_FONT_SIZE, useUiStore, type PanelPosition } from "../../store/ui";
import { useSettingsStore, type SettingKey } from "../../store/settings";
import { THEMES, themeById, type ThemeKind } from "../../theme/themes";
import { isTauri } from "../../lib/tauri";
import { openFile } from "../../workbench/commands";

const themesOf = (kind: ThemeKind) => THEMES.filter((t) => t.kind === kind);

function ThemeOptions({ kind }: { kind: ThemeKind }) {
  return themesOf(kind).map((t) => (
    <option key={t.id} value={t.id}>
      {t.name}
    </option>
  ));
}

const AUTO_SAVE: { value: string; label: string }[] = [
  { value: "off", label: "Wyłączony – zapis przez Ctrl+S" },
  { value: "afterDelay", label: "Po chwili bez pisania (1 s)" },
  { value: "onFocusChange", label: "Po wyjściu z edytora" },
];

const PANEL_POSITIONS: { value: PanelPosition; label: string }[] = [
  { value: "bottom", label: "Pod edytorem" },
  { value: "right", label: "Obok edytora (po prawej)" },
];

const inputClass =
  "rounded border border-lf-border bg-lf-editor px-2 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent";

/** Settings stored in settings.json (also editable as a file). */
export function SettingsView() {
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const theme = useUiStore((s) => s.theme);
  const darkTheme = useUiStore((s) => s.darkTheme);
  const lightTheme = useUiStore((s) => s.lightTheme);
  const panelPosition = useUiStore((s) => s.panelPosition);
  const setPanelPosition = useUiStore((s) => s.setPanelPosition);
  const settingsError = useSettingsStore((s) => s.error);
  const update = useSettingsStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  const fontId = useId();
  const sizeId = useId();
  const themeId = useId();
  const darkId = useId();
  const lightId = useId();
  const positionId = useId();
  const autoSaveId = useId();
  const autoSave = useSettingsStore((s) => (typeof s.values.autoSave === "string" ? s.values.autoSave : "off"));
  const confirmCommands = useSettingsStore((s) => s.values.acpConfirmCommands !== false);

  const save = async (key: SettingKey, value: unknown) => {
    // Apply immediately, persist in settings.json (in the browser there is no file).
    const ui = useUiStore.getState();
    if (key === "theme") ui.setTheme(String(value));
    if (key === "darkTheme") ui.setThemePreferences({ darkTheme: String(value) });
    if (key === "lightTheme") ui.setThemePreferences({ lightTheme: String(value) });
    if (key === "fontFamily") ui.setFontMono(String(value));
    if (key === "fontSize") ui.setFontSize(Number(value));
    setError(await update(key, value));
  };

  // A chosen theme also becomes the preferred one of its kind (used by "system" and the toggle command).
  const saveTheme = async (id: string) => {
    await save("theme", id);
    const kind = themeById(id)?.kind;
    if (kind === "dark" && darkTheme !== id) await save("darkTheme", id);
    if (kind === "light" && lightTheme !== id) await save("lightTheme", id);
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
        <select id={themeId} value={theme} onChange={(e) => void saveTheme(e.target.value)} className={inputClass}>
          <optgroup label="Ciemne">
            <ThemeOptions kind="dark" />
          </optgroup>
          <optgroup label="Jasne">
            <ThemeOptions kind="light" />
          </optgroup>
          <option value="system">Jak w systemie</option>
        </select>
      </div>
      {theme === "system" && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={darkId} className="text-xs font-semibold text-lf-fg">
              Motyw, gdy system jest ciemny
            </label>
            <select id={darkId} value={darkTheme} onChange={(e) => void save("darkTheme", e.target.value)} className={inputClass}>
              <ThemeOptions kind="dark" />
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={lightId} className="text-xs font-semibold text-lf-fg">
              Motyw, gdy system jest jasny
            </label>
            <select id={lightId} value={lightTheme} onChange={(e) => void save("lightTheme", e.target.value)} className={inputClass}>
              <ThemeOptions kind="light" />
            </select>
          </div>
        </>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={autoSaveId} className="text-xs font-semibold text-lf-fg">
          Automatyczny zapis plików
        </label>
        <select id={autoSaveId} value={autoSave} onChange={(e) => void save("autoSave", e.target.value)} className={inputClass}>
          {AUTO_SAVE.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-start gap-2 text-xs text-lf-fg">
        <input
          type="checkbox"
          checked={confirmCommands}
          onChange={(e) => void save("acpConfirmCommands", e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">Pytaj przed poleceniami agentów</span>
          <span className="block text-[11px] text-lf-subtle">
            W trybie rozmowy Leverframe pyta, zanim agent uruchomi polecenie w terminalu (zalecane).
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor={positionId} className="text-xs font-semibold text-lf-fg">
          Panel terminala
        </label>
        <select
          id={positionId}
          value={panelPosition}
          onChange={(e) => setPanelPosition(e.target.value as PanelPosition)}
          className={inputClass}
        >
          {PANEL_POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
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
