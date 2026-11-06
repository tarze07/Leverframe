import { useId, useState } from "react";
import {
  profileToSshForm,
  sshFormToProfile,
  validateSshForm,
  type Profile,
  type SshFormValues,
} from "./profilesClient";

interface Props {
  profile?: Profile;
  onSave: (profile: Profile) => Promise<unknown>;
  onCancel: () => void;
}

const FIELDS: { key: keyof SshFormValues; label: string; placeholder: string; hint?: string }[] = [
  { key: "host", label: "Host", placeholder: "serwer.example.com lub 10.0.0.5" },
  { key: "user", label: "Użytkownik", placeholder: "opcjonalnie" },
  { key: "port", label: "Port", placeholder: "22" },
  { key: "identityFile", label: "Klucz prywatny", placeholder: "~/.ssh/id_ed25519 (opcjonalnie)" },
  { key: "name", label: "Nazwa", placeholder: "domyślnie host" },
];

/** Add / edit an SSH host. Passwords are never stored – `ssh` asks for them in the terminal. */
export function SshProfileForm({ profile, onSave, onCancel }: Props) {
  const [values, setValues] = useState<SshFormValues>(() => profileToSshForm(profile));
  const [errors, setErrors] = useState<Partial<Record<keyof SshFormValues, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idPrefix = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateSshForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(sshFormToProfile(values, profile));
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3" aria-label="Host SSH">
      <h2 className="text-xs font-semibold text-lf-fg">{profile ? "Edytuj host SSH" : "Nowy host SSH"}</h2>
      {FIELDS.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-${f.key}`} className="text-xs text-lf-muted">
            {f.label}
          </label>
          <input
            id={`${idPrefix}-${f.key}`}
            value={values[f.key]}
            placeholder={f.placeholder}
            inputMode={f.key === "port" ? "numeric" : undefined}
            autoFocus={f.key === "host"}
            spellCheck={false}
            aria-invalid={!!errors[f.key]}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className={`rounded border bg-lf-editor px-2 py-1 text-xs text-lf-fg outline-none placeholder:text-lf-subtle ${
              errors[f.key] ? "border-lf-danger" : "border-lf-border focus:border-lf-accent"
            }`}
          />
          {errors[f.key] && <span className="text-[11px] text-lf-danger">{errors[f.key]}</span>}
        </div>
      ))}
      <p className="text-[11px] leading-relaxed text-lf-subtle">
        Hasło nie jest zapisywane. Logowanie odbywa się kluczem lub przez ssh-agent; o hasło zapyta <code>ssh</code> w
        terminalu.
      </p>
      {saveError && <p className="text-[11px] text-lf-danger">{saveError}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-lf-accent px-3 py-1 text-xs text-lf-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          Zapisz
        </button>
        <button type="button" onClick={onCancel} className="rounded px-3 py-1 text-xs text-lf-muted hover:bg-lf-hover hover:text-lf-fg">
          Anuluj
        </button>
      </div>
    </form>
  );
}
