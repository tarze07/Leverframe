import type { ConfigOption, ConfigSelectOption, ModeState } from "./acpClient";

const selectClass =
  "max-w-40 rounded border border-lf-border bg-lf-bg px-1 py-0.5 text-[11px] text-lf-fg outline-none focus:border-lf-accent disabled:opacity-50";

/** The agent's modes and options (model, reasoning, …) as lists the user can change. */
export function SessionControls(props: {
  modes: ModeState | null;
  options: ConfigOption[];
  disabled: boolean;
  onMode: (modeId: string) => void;
  onOption: (configId: string, value: string | boolean) => void;
}) {
  if (!props.modes?.availableModes.length && props.options.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-lf-border px-2 pt-1.5 text-[11px] text-lf-muted">
      {props.modes && props.modes.availableModes.length > 0 && (
        <label className="flex items-center gap-1">
          Tryb
          <select
            aria-label="Tryb agenta"
            value={props.modes.currentModeId}
            disabled={props.disabled}
            onChange={(e) => props.onMode(e.target.value)}
            className={selectClass}
          >
            {props.modes.availableModes.map((m) => (
              <option key={m.id} value={m.id} title={m.description ?? undefined}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {props.options.map((o) =>
        o.type === "boolean" ? (
          <label key={o.id} className="flex items-center gap-1" title={o.description ?? undefined}>
            <input
              type="checkbox"
              checked={o.currentValue}
              disabled={props.disabled}
              onChange={(e) => props.onOption(o.id, e.target.checked)}
            />
            {o.name}
          </label>
        ) : o.type === "select" ? (
          <label key={o.id} className="flex items-center gap-1" title={o.description ?? undefined}>
            {o.name}
            <select
              aria-label={o.name}
              value={o.currentValue}
              disabled={props.disabled}
              onChange={(e) => props.onOption(o.id, e.target.value)}
              className={selectClass}
            >
              {o.options.map((item) =>
                "group" in item ? (
                  <optgroup key={item.group} label={item.name}>
                    {item.options.map((x: ConfigSelectOption) => (
                      <option key={x.value} value={x.value}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={item.value} value={item.value}>
                    {item.name}
                  </option>
                ),
              )}
            </select>
          </label>
        ) : null,
      )}
    </div>
  );
}
