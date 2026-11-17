import { useId, useState } from "react";
import { useAgentsStore } from "../../store/agents";
import type { Agent, AgentSettings } from "./agentsClient";

const fieldClass =
  "w-full rounded border border-lf-border bg-lf-bg px-1.5 py-1 font-mono text-[11px] text-lf-fg outline-none placeholder:text-lf-subtle focus:border-lf-accent";

/** Words of a command line: separated by spaces, `'…'` or `"…"` keep spaces inside a word. */
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The words back as one line (words with spaces or quotes in quotes). */
export function joinArgs(words: string[]): string {
  return words.map((w) => (w === "" || /[\s'"]/.test(w) ? (w.includes("'") ? `"${w}"` : `'${w}'`) : w)).join(" ");
}

/** `NAME=value` lines; lines without `=` give an empty value (the backend refuses bad names). */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i < 0) env[line] = "";
    else env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return env;
}

const sameWords = (a: string[] | null | undefined, b: string[] | null | undefined) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((w, i) => w === (b ?? [])[i]);

/** The agent's settings now (what the form starts with). */
export function currentSettings(agent: Agent): AgentSettings {
  const acpLine = agent.acp ? [agent.acp.command, ...agent.acp.args] : null;
  return {
    args: agent.args ?? [],
    env: agent.env ?? {},
    acp: acpLine && !sameWords(acpLine, agent.defaultAcp) ? acpLine : null,
    hidden: agent.hidden ?? false,
  };
}

/** Whether the agent differs from what Leverframe defines. */
export function isCustomized(agent: Agent): boolean {
  const s = currentSettings(agent);
  return s.args.length > 0 || Object.keys(s.env).length > 0 || s.acp !== null || s.hidden;
}

/**
 * Settings of an agent: arguments in a terminal, environment variables (terminal and
 * conversation), the conversation-mode command, hiding. Saved as an override in agents.json.
 */
export function AgentSettingsForm({ agent, onDone }: { agent: Agent; onDone: (saved: boolean) => void }) {
  const saveSettings = useAgentsStore((s) => s.saveSettings);
  const configPath = useAgentsStore((s) => s.configPath);
  const start = currentSettings(agent);
  const ids = { args: useId(), env: useId(), acp: useId() };
  const [args, setArgs] = useState(joinArgs(start.args));
  const [env, setEnv] = useState(
    Object.entries(start.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [acp, setAcp] = useState(start.acp ? joinArgs(start.acp) : "");
  const [hidden, setHidden] = useState(start.hidden);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasAcp = !!agent.acp || !!agent.defaultAcp;
  const command = agent.commands[0];

  const save = async (settings: AgentSettings) => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings(agent.id, settings);
      onDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const typedArgs = splitArgs(args);
  const label = "text-[11px] font-semibold text-lf-fg";
  return (
    <form
      aria-label={`Ustawienia ${agent.name}`}
      className="mt-2 flex flex-col gap-1 rounded border border-lf-border bg-lf-elevated p-2 text-[11px]"
      onSubmit={(e) => {
        e.preventDefault();
        const acpWords = splitArgs(acp);
        void save({ args: typedArgs, env: parseEnvLines(env), acp: acpWords.length > 0 ? acpWords : null, hidden });
      }}
    >
      <label htmlFor={ids.args} className={label}>
        Argumenty w terminalu
      </label>
      <input
        id={ids.args}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        spellCheck={false}
        placeholder={agent.id === "opencode" ? "np. --model anthropic/claude-sonnet-4-5" : "np. --model …"}
        className={fieldClass}
      />
      <span className="text-lf-subtle">
        Uruchomi się: <code className="break-all font-mono text-lf-muted">{[command, ...typedArgs.map((a) => joinArgs([a]))].join(" ")}</code>
      </span>

      <label htmlFor={ids.env} className={label}>
        Zmienne środowiskowe (NAZWA=wartość, jedna w linii)
      </label>
      <textarea id={ids.env} value={env} onChange={(e) => setEnv(e.target.value)} rows={2} spellCheck={false} className={fieldClass} />
      <span className="text-lf-subtle">
        Dla terminala i trybu rozmowy, w każdym profilu. Są zapisane jawnie w agents.json – klucze API lepiej podać przy logowaniu agenta.
      </span>

      {hasAcp && (
        <>
          <label htmlFor={ids.acp} className={label}>
            Tryb rozmowy – program i argumenty
          </label>
          <input
            id={ids.acp}
            value={acp}
            onChange={(e) => setAcp(e.target.value)}
            spellCheck={false}
            placeholder={agent.defaultAcp ? `${joinArgs(agent.defaultAcp)} (domyślnie)` : "np. agent --acp"}
            className={fieldClass}
          />
        </>
      )}

      <label className="mt-1 flex items-center gap-2 text-lf-fg">
        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
        Ukryj w panelu „Agenci”
      </label>

      {error && (
        <p role="alert" className="text-lf-danger">
          {error}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <button type="submit" disabled={saving} className="rounded bg-lf-accent px-2 py-0.5 text-lf-accent-fg hover:opacity-90 disabled:opacity-50">
          Zapisz
        </button>
        {isCustomized(agent) && (
          <button
            type="button"
            disabled={saving}
            title="Usuwa ustawienia tego agenta z agents.json"
            onClick={() => void save({ args: [], env: {}, acp: null, hidden: false })}
            className="rounded border border-lf-border px-2 py-0.5 text-lf-fg hover:bg-lf-hover disabled:opacity-50"
          >
            Przywróć domyślne
          </button>
        )}
        <button type="button" onClick={() => onDone(false)} className="rounded px-2 py-0.5 text-lf-muted hover:text-lf-fg">
          Anuluj
        </button>
      </div>
      {configPath && (
        <p className="text-lf-subtle">
          Zapis w <code className="break-all font-mono">{configPath}</code>.
        </p>
      )}
    </form>
  );
}
