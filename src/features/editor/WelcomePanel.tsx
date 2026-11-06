const SHORTCUTS: [string, string][] = [
  ["Ctrl+B", "Pokaż / ukryj panel boczny"],
  ["Ctrl+J", "Pokaż / ukryj panel dolny"],
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
        <table className="text-sm">
          <tbody>
            {SHORTCUTS.map(([keys, desc]) => (
              <tr key={keys}>
                <td className="py-1 pr-6 text-right">
                  <kbd className="rounded border border-lf-border bg-lf-elevated px-1.5 py-0.5 font-mono text-xs text-lf-fg">
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
