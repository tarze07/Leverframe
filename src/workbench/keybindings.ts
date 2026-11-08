/**
 * Keybinding strings such as "Ctrl+Shift+P" or "Ctrl+`": parsing, matching keyboard events
 * (by physical key, so they work on any keyboard layout) and display.
 */

export interface KeyChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string; // normalized: "p", "`", "f5", "enter", …
}

const MOD_ALIASES: Record<string, keyof Omit<KeyChord, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  win: "meta",
  super: "meta",
};

/** "Ctrl+Shift+P" → chord; null for invalid strings. */
export function parseKeybinding(text: string): KeyChord | null {
  const parts = text
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p, i, all) => p !== "" || (i === all.length - 1 && text.endsWith("++")));
  if (text.trim().endsWith("++")) parts[parts.length - 1] = "+";
  if (parts.length === 0) return null;
  const chord: KeyChord = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const [i, p] of parts.entries()) {
    const mod = MOD_ALIASES[p];
    if (mod && i < parts.length - 1) chord[mod] = true;
    else if (i === parts.length - 1) chord.key = p;
    else return null;
  }
  return chord.key ? chord : null;
}

const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "space",
};

/** Normalized key of an event, based on the physical key where possible. */
export function eventKey(e: Pick<KeyboardEvent, "code" | "key">): string {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  return (e.key ?? "").toLowerCase();
}

type KeyEventLike = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

export function matches(chord: KeyChord, e: KeyEventLike): boolean {
  return (
    chord.ctrl === e.ctrlKey &&
    chord.shift === e.shiftKey &&
    chord.alt === e.altKey &&
    chord.meta === e.metaKey &&
    chord.key === eventKey(e)
  );
}

/** "ctrl+shift+p" → "Ctrl+Shift+P" for display. */
export function formatKeybinding(text: string): string {
  const c = parseKeybinding(text);
  if (!c) return text;
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1);
  return [c.ctrl && "Ctrl", c.shift && "Shift", c.alt && "Alt", c.meta && "Meta", key].filter(Boolean).join("+");
}

/**
 * Effective bindings: defaults, overridden by the user (a string replaces, `null` removes).
 * Invalid user strings are reported and ignored.
 */
export function resolveBindings(
  defaults: Record<string, string | undefined>,
  overrides: Record<string, string | null>,
): { bindings: Map<string, KeyChord>; errors: string[] } {
  const bindings = new Map<string, KeyChord>();
  const errors: string[] = [];
  for (const [id, key] of Object.entries(defaults)) {
    const chord = key ? parseKeybinding(key) : null;
    if (chord) bindings.set(id, chord);
  }
  for (const [id, key] of Object.entries(overrides)) {
    if (key === null) {
      bindings.delete(id);
      continue;
    }
    const chord = parseKeybinding(key);
    if (chord) bindings.set(id, chord);
    else errors.push(`keybindings.${id}: nieprawidłowy skrót „${key}”`);
  }
  return { bindings, errors };
}
