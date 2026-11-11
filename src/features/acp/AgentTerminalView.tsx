import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAgentTerminalsStore } from "../../store/agentTerminals";
import { useUiStore } from "../../store/ui";
import { terminalTheme } from "../terminal/theme";

/**
 * Read-only terminal showing an agent's command as it runs (in a tool card, or full size in the
 * terminal panel). It follows the shared store, so both views stay in sync.
 */
export function AgentTerminalView({ storeKey, rows }: { storeKey: string; rows?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const exists = useAgentTerminalsStore((s) => !!s.terminals[storeKey]);
  const themeId = useUiStore((s) => s.resolvedThemeId);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = container.current;
    if (!el || !exists) return;
    const { fontMono, fontSize, resolvedThemeId } = useUiStore.getState();
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "underline",
      fontFamily: fontMono,
      fontSize,
      rows: rows ?? 24,
      scrollback: 10_000,
      theme: terminalTheme(resolvedThemeId),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const refit = () => {
      if (el.clientWidth === 0) return;
      try {
        if (rows) term.resize(Math.max(20, fit.proposeDimensions()?.cols ?? 80), rows);
        else fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    refit();
    const observer = new ResizeObserver(() => requestAnimationFrame(refit));
    observer.observe(el);

    // Write what is there, then only what arrives (from the start again if old output was dropped).
    let written = 0;
    let dropped = 0;
    const sync = () => {
      const t = useAgentTerminalsStore.getState().terminals[storeKey];
      if (!t) return;
      if (t.dropped !== dropped) {
        term.reset();
        written = 0;
        dropped = t.dropped;
      }
      if (t.data.length > written) {
        term.write(t.data.slice(written));
        written = t.data.length;
      }
    };
    sync();
    const unsubscribe = useAgentTerminalsStore.subscribe(sync);
    return () => {
      unsubscribe();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [storeKey, exists, rows]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(themeId);
  }, [themeId]);

  if (!exists) return <p className="px-2 py-1 text-[11px] text-lf-subtle">Wyjście polecenia nie jest już dostępne.</p>;
  return <div ref={container} className={rows ? "w-full overflow-hidden" : "h-full w-full"} data-testid="agent-terminal" />;
}
