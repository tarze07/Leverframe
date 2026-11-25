/** The first message for an agent started on a task, unless settings.json says otherwise (`tasksPrompt`). */
export const DEFAULT_TASK_PROMPT =
  "Wykonaj zadanie opisane w pliku {plik} ({tytul}). Na końcu dopisz do tego pliku sekcję „## Wynik” z podsumowaniem zmian.";

/** `{plik}` and `{tytul}` of the template filled in (`{plik}` is added when the template has none). */
export function taskPrompt(template: string | null | undefined, file: string, title: string): string {
  const t = template?.trim() ? template : DEFAULT_TASK_PROMPT;
  const filled = t.replaceAll("{plik}", file).replaceAll("{tytul}", title);
  return t.includes("{plik}") ? filled : `${filled} (${file})`;
}
