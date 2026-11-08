import { openTerminal } from "../../workbench/commands";

const SHORTCUTS: [string, string][] = [
  ["Ctrl+P", "Szybkie otwieranie pliku"],
  ["Ctrl+S", "Zapisz plik"],
  ["Ctrl+`", "Pokaż / ukryj terminal"],
  ["Ctrl+Shift+`", "Nowy terminal"],
  ["Ctrl+B", "Pokaż / ukryj panel boczny"],
  ["Ctrl+J", "Pokaż / ukryj panel dolny"],
  ["Ctrl+F", "Szukaj w terminalu"],
  ["Ctrl+Shift+C / V", "Kopiuj / wklej w terminalu"],
  ["Przeciągnij zakładkę", "Podziel obszar w poziomie lub pionie"],
];

export function WelcomePanel() {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-lf-editor p-8">
      <div className="flex max-w-md flex-col gap-6">
        <div>
          <h1 className="text-2xl font-light text-lf-fg">Leverframe</h1>
          <p className="mt-1 text-sm text-lf-muted">Terminal z edytorem dla agentów CLI</p>
        </div>
        <div className="flex flex-col items-start gap-1 text-sm">
          <ActionLink icon="terminal" label="Nowy terminal" onClick={() => openTerminal()} />
          <ActionLink icon="split-horizontal" label="Nowy terminal w obszarze edytora" onClick={() => openTerminal({ dock: "main" })} />
        </div>
        <table className="text-sm">
          <tbody>
            {SHORTCUTS.map(([keys, desc]) => (
              <tr key={keys}>
                <td className="py-1 pr-6 text-right">
                  <kbd className="rounded border border-lf-border bg-lf-elevated px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-lf-fg">
                    {keys}
                  </kbd>
                </td>
                <td className="py-1 text-lf-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionLink({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 text-lf-accent hover:underline">
      <span className={`codicon codicon-${icon}`} aria-hidden />
      {label}
    </button>
  );
}
