import { useEffect, useState } from "react";
import type { AcpHandle, AgentSessionInfo } from "./acpClient";

const when = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
};

/**
 * The agent's own saved sessions in this folder (`session/list`), e.g. ones started in its
 * terminal mode: open one in the panel or, on an explicit request, delete it at the agent.
 */
export function AgentSessions({
  handle,
  currentId,
  canDelete,
  onOpen,
  onClose,
}: {
  handle: AcpHandle;
  currentId: string | null;
  canDelete: boolean;
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = (next: string | null) =>
    handle.listSessions(next).then(
      (r) => {
        setSessions((prev) => [...(next ? (prev ?? []) : []), ...r.sessions]);
        setCursor(r.nextCursor ?? null);
      },
      (e: unknown) => setError(String(e)),
    );

  useEffect(() => {
    void load(null);
    // Loaded once per opening of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  const remove = (sessionId: string) => {
    setConfirm(null);
    handle.deleteSession(sessionId).then(
      () => setSessions((list) => list?.filter((s) => s.sessionId !== sessionId) ?? null),
      (e: unknown) => setError(String(e)),
    );
  };

  return (
    <section aria-label="Rozmowy zapisane przez agenta" className="shrink-0 border-b border-lf-border bg-lf-elevated px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-lf-fg">Rozmowy zapisane przez agenta</span>
        <button type="button" onClick={onClose} aria-label="Zamknij listę" className="rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg">
          <span className="codicon codicon-close" aria-hidden />
        </button>
      </div>
      {error && <p className="mb-1 text-lf-danger">{error}</p>}
      {sessions === null && !error && <p className="text-lf-subtle">Wczytywanie…</p>}
      {sessions?.length === 0 && <p className="text-lf-subtle">Agent nie ma zapisanych rozmów w tym folderze.</p>}
      <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto">
        {sessions?.map((s) => {
          const current = s.sessionId === currentId;
          return (
            <li key={s.sessionId} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-lf-hover">
              <span className="min-w-0 flex-1 truncate text-lf-fg" title={s.sessionId}>
                {s.title || s.sessionId}
              </span>
              {when(s.updatedAt) && <span className="shrink-0 text-[11px] text-lf-subtle">{when(s.updatedAt)}</span>}
              {current ? (
                <span className="shrink-0 text-[11px] text-lf-accent">bieżąca</span>
              ) : confirm === s.sessionId ? (
                <>
                  <span className="shrink-0 text-lf-fg">Usunąć u agenta?</span>
                  <button type="button" onClick={() => remove(s.sessionId)} className="shrink-0 rounded bg-lf-danger px-1.5 text-white">
                    Usuń
                  </button>
                  <button type="button" onClick={() => setConfirm(null)} className="shrink-0 text-lf-muted hover:text-lf-fg">
                    Anuluj
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onOpen(s.sessionId)}
                    className="shrink-0 rounded border border-lf-border px-1.5 text-lf-fg hover:bg-lf-hover"
                  >
                    Otwórz
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      title="Usuń rozmowę u agenta"
                      aria-label={`Usuń rozmowę ${s.title || s.sessionId} u agenta`}
                      onClick={() => setConfirm(s.sessionId)}
                      className="shrink-0 rounded p-0.5 text-lf-muted hover:bg-lf-hover hover:text-lf-fg"
                    >
                      <span className="codicon codicon-trash" aria-hidden />
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {cursor && (
        <button type="button" onClick={() => void load(cursor)} className="mt-1 text-lf-accent hover:underline">
          Więcej…
        </button>
      )}
    </section>
  );
}
