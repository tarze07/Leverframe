import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

import { useUiStore } from "../../store/ui";
import { TerminalSearch } from "../terminal/TerminalSearch";
import { terminalTheme } from "../terminal/theme";
import { CastPlayer, compressIdle, formatClock, parseCast, type Cast } from "./cast";
import { sessionsClient } from "./sessionsClient";

export interface SessionPlayerParams {
  sessionId: number;
  /** Search text from the Sessions panel: the player jumps to the end and highlights it. */
  query?: string;
}

const SPEEDS = [0.5, 1, 2, 4, 8];
const MAX_IDLE = 2;

/** Dock panel replaying a recorded session (asciicast) in a read-only terminal. */
export function SessionPlayer({ params }: IDockviewPanelProps<SessionPlayerParams>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const playerRef = useRef<CastPlayer | null>(null);
  const rawRef = useRef<Cast | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(true);
  const themeId = useUiStore((s) => s.resolvedThemeId);

  const sync = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    setPosition(p.position);
    setPlaying(p.playing);
  }, []);

  const build = useCallback(
    (raw: Cast, compress: boolean, keepRatio?: number) => {
      const term = termRef.current;
      if (!term) return;
      const cast = compress ? compressIdle(raw, MAX_IDLE) : raw;
      const player = new CastPlayer(cast, {
        reset: () => term.reset(),
        write: (d) => term.write(d),
        resize: (c, r) => term.resize(Math.max(2, c), Math.max(1, r)),
      });
      player.speed = playerRef.current?.speed ?? 1;
      if (keepRatio !== undefined) player.seek(keepRatio * cast.duration);
      playerRef.current = player;
      setDuration(cast.duration);
      sync();
    },
    [sync],
  );

  // Terminal + loading the recording.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { fontMono, fontSize } = useUiStore.getState();
    const term = new Terminal({
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: fontMono,
      fontSize,
      scrollback: 20_000,
      theme: terminalTheme(useUiStore.getState().resolvedThemeId),
    });
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return false;
      }
      return true;
    });
    termRef.current = term;
    setSearch(searchAddon);

    let cancelled = false;
    sessionsClient
      .read(params.sessionId)
      .then((text) => {
        if (cancelled) return;
        const raw = parseCast(text);
        rawRef.current = raw;
        build(raw, true);
        setLoaded(true);
        if (params.query?.trim()) {
          // Show the whole session and highlight the searched text.
          playerRef.current?.seek(playerRef.current.duration);
          sync();
          setSearchOpen(true);
        }
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));

    return () => {
      cancelled = true;
      term.dispose();
      termRef.current = null;
      playerRef.current = null;
    };
  }, [params.sessionId, params.query, build, sync]);

  // Follow the light / dark theme.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(themeId);
  }, [themeId]);

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      playerRef.current?.tick((now - last) / 1000);
      last = now;
      sync();
      if (playerRef.current?.playing) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, sync]);

  const toggle = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) p.pause();
    else p.play();
    sync();
  };

  const seek = (t: number) => {
    playerRef.current?.seek(t);
    sync();
  };

  return (
    <div className="flex h-full flex-col bg-lf-editor">
      <div className="relative min-h-0 flex-1 overflow-auto p-2">
        <div ref={containerRef} className="inline-block" data-testid="player-terminal" />
        {searchOpen && search && (
          <TerminalSearch
            addon={search}
            initialQuery={params.query}
            onClose={() => {
              setSearchOpen(false);
              search.clearDecorations();
            }}
          />
        )}
        {error && <p className="absolute inset-x-4 top-4 rounded bg-lf-elevated p-3 text-xs text-lf-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-lf-border bg-lf-panel px-3 py-1.5 text-xs text-lf-muted">
        <button
          type="button"
          disabled={!loaded}
          onClick={toggle}
          title={playing ? "Pauza" : "Odtwórz"}
          aria-label={playing ? "Pauza" : "Odtwórz"}
          className="rounded p-1 text-lf-fg hover:bg-lf-hover disabled:opacity-40"
        >
          <span className={`codicon codicon-${playing ? "debug-pause" : "play"}`} aria-hidden />
        </button>
        <span className="w-24 shrink-0 tabular-nums">
          {formatClock(position)} / {formatClock(duration)}
        </span>
        <input
          type="range"
          aria-label="Pozycja"
          min={0}
          max={duration || 0}
          step={0.1}
          value={position}
          disabled={!loaded}
          onChange={(e) => seek(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[var(--lf-accent)]"
        />
        <select
          aria-label="Prędkość"
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            if (playerRef.current) playerRef.current.speed = v;
          }}
          className="rounded border border-lf-border bg-lf-editor px-1 py-0.5 text-xs text-lf-fg"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <label className="flex shrink-0 items-center gap-1" title={`Skraca przerwy dłuższe niż ${MAX_IDLE} s`}>
          <input
            type="checkbox"
            checked={skipIdle}
            disabled={!loaded}
            onChange={(e) => {
              setSkipIdle(e.target.checked);
              const raw = rawRef.current;
              const p = playerRef.current;
              if (raw && p) build(raw, e.target.checked, p.duration ? p.position / p.duration : 0);
            }}
          />
          Pomijaj przerwy
        </label>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          title="Szukaj (Ctrl+F)"
          aria-label="Szukaj w nagraniu"
          className="rounded p-1 hover:bg-lf-hover hover:text-lf-fg"
        >
          <span className="codicon codicon-search" aria-hidden />
        </button>
      </div>
    </div>
  );
}
