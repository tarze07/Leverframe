import { useId } from "react";
import { DEFAULT_FONT_MONO, DEFAULT_FONT_SIZE, useUiStore } from "../../store/ui";

export function SettingsView() {
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const setFontMono = useUiStore((s) => s.setFontMono);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fontId = useId();
  const sizeId = useId();

  return (
    <form className="flex flex-col gap-4 px-4 py-2" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-1">
        <label htmlFor={fontId} className="text-xs font-semibold text-lf-fg">
          Czcionka terminala i edytora
        </label>
        <input
          id={fontId}
          defaultValue={fontMono}
          onBlur={(e) => setFontMono(e.target.value)}
          className="rounded border border-lf-border bg-lf-editor px-2 py-1 font-mono text-xs text-lf-fg outline-none focus:border-lf-accent"
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
          onChange={(e) => setFontSize(e.target.valueAsNumber)}
          className="w-24 rounded border border-lf-border bg-lf-editor px-2 py-1 text-xs text-lf-fg outline-none focus:border-lf-accent"
        />
        <span className="text-[11px] text-lf-subtle">Domyślnie: {DEFAULT_FONT_SIZE}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-lf-subtle">
        Pełne ustawienia w pliku <code className="font-mono">settings.json</code> pojawią się w etapie 7 (#9).
      </p>
    </form>
  );
}
