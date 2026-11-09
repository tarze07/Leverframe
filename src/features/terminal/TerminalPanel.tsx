import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";

import { Placeholder } from "../../components/Placeholder";
import { isTauri } from "../../lib/tauri";
import { useTerminalStore } from "../../store/terminal";
import { useUiStore } from "../../store/ui";
import { programTitle, spawnPty, type PtyHandle } from "./ptyClient";
import { terminalKeyAction } from "./keys";
import { isAppShortcut } from "../../lib/useKeybindings";
import { terminalRegistry } from "./registry";
import { createAgentStarter, type AgentStarter } from "./agentStart";
import { useAgentsStore } from "../../store/agents";
import { terminalTheme } from "./theme";
import { TerminalSearch } from "./TerminalSearch";

export interface TerminalPanelParams {
  /** Terminal profile; the default profile is used when neither this nor `program` is set. */
  profileId?: string;
  /** Agent to start in the terminal; its command is typed once the shell is ready. */
  agentId?: string;
  /** Command typed once the shell is ready (resume a session, re-run a command). */
  initialCommand?: string;
  /** Press Enter after `initialCommand` (default false: the user reviews and runs it). */
  submitInitial?: boolean;
  /** Explicit program (bypasses profiles). */
  program?: string;
  /** Dock the panel lives in (for the running-terminals list). */
  dock?: "main" | "panel";
  args?: string[];
  cwd?: string;
}

/** Dockview panel hosting one xterm.js terminal connected to a backend PTY. */
export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  if (!isTauri()) {
    return (
      <div className="h-full bg-lf-editor">
        <Placeholder icon="terminal" title="Terminal działa tylko w aplikacji desktopowej">
          Uruchom aplikację poleceniem <code className="font-mono">npm run tauri dev</code>.
        </Placeholder>
      </div>
    );
  }
  return <XtermTerminal {...props} />;
}

function XtermTerminal({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const fontMono = useUiStore((s) => s.fontMono);
  const fontSize = useUiStore((s) => s.fontSize);
  const themeId = useUiStore((s) => s.resolvedThemeId);

  // Create the terminal and its PTY once per panel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { fontMono, fontSize } = useUiStore.getState();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: fontMono,
      fontSize,
      scrollback: 10_000,
      theme: terminalTheme(useUiStore.getState().resolvedThemeId),
    });
    termRef.current = term;

    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Ctrl/Cmd+click opens links in the system browser (as in VS Code).
        if (event.ctrlKey || event.metaKey) void openUrl(uri).catch(() => undefined);
      }),
    );
    term.open(container);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable: xterm falls back to the DOM renderer.
    }
    setSearch(searchAddon);

    let pty: PtyHandle | null = null;
    let disposed = false;
    let starter: AgentStarter | null = null;
    let earlyOutput = "";
    const decoder = new TextDecoder();
    const program = params?.program;
    const terminals = useTerminalStore.getState();
    const setTitle = (t: string) => {
      api.setTitle(t);
      useTerminalStore.getState().update(api.id, { title: t });
    };
    terminals.upsert({
      panelId: api.id,
      dock: params?.dock ?? "panel",
      title: api.title ?? "Terminal",
      profileId: params?.profileId ?? null,
      agentId: params?.agentId ?? null,
      exited: false,
    });

    const safeFit = () => {
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* not attached yet */
      }
    };
    safeFit();

    term.attachCustomKeyEventHandler((e) => {
      const action = terminalKeyAction(e, term.hasSelection(), undefined, isAppShortcut);
      switch (action) {
        case "app":
          return false; // bubbles to the global shortcuts
        case "copy":
          if (term.hasSelection()) void writeText(term.getSelection()).catch(() => undefined);
          term.clearSelection();
          e.preventDefault();
          return false;
        case "paste":
          void readText()
            .then((text) => text && term.paste(text))
            .catch(() => undefined);
          e.preventDefault();
          return false;
        case "find":
          setSearchOpen(true);
          e.preventDefault();
          return false;
        default:
          return true;
      }
    });

    const subscriptions = [
      term.onData((data) => void pty?.write(data).catch(() => undefined)),
      term.onResize(({ cols, rows }) => void pty?.resize(cols, rows).catch(() => undefined)),
      term.onTitleChange((t) => t && setTitle(t)),
    ];

    const onFocus = () => useTerminalStore.getState().setActive(api.id);
    term.textarea?.addEventListener("focus", onFocus);

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(safeFit);
    });
    observer.observe(container);

    const activeSub = api.onDidActiveChange(({ isActive }) => {
      if (isActive) requestAnimationFrame(() => term.focus());
    });

    const unregister = terminalRegistry.register(api.id, {
      focus: () => term.focus(),
      clear: () => term.clear(),
    });

    spawnPty(
      {
        profileId: params?.profileId,
        agentId: params?.agentId,
        program,
        args: params?.args,
        cwd: params?.cwd,
        cols: term.cols,
        rows: term.rows,
      },
      {
        onData: (bytes) => {
          term.write(bytes);
          const text = decoder.decode(bytes, { stream: true });
          if (starter) starter.onOutput(text);
          else earlyOutput = (earlyOutput + text).slice(-500);
        },
        onExit: (code) => {
          if (disposed) return;
          useTerminalStore.getState().update(api.id, { exited: true });
          if (code === 0) {
            api.close(); // normal `exit` closes the tab, like VS Code
          } else {
            term.write(`\r\n\x1b[90m[Proces zakończony${code === null ? "" : `, kod ${code}`}]\x1b[0m\r\n`);
          }
        },
      },
    )
      .then((handle) => {
        if (disposed) {
          void handle.kill();
          return;
        }
        pty = handle;
        useTerminalStore.getState().update(api.id, { profileId: handle.profileId, agentId: handle.agentId });
        const agentName = useAgentsStore.getState().agentById(handle.agentId)?.name;
        const base = handle.profileName ?? programTitle(handle.program);
        setTitle(agentName ? `${agentName} · ${base}` : base);
        const startCommand = handle.agentCommand ?? params?.initialCommand;
        if (startCommand) {
          starter = createAgentStarter({
            command: startCommand,
            submit: handle.agentCommand ? true : (params?.submitInitial ?? false),
            write: (data) => void handle.write(data).catch(() => undefined),
            onBlocked: () =>
              term.write(
                `\r\n\x1b[90m[Leverframe: ${startCommand} zostanie wpisane po zalogowaniu]\x1b[0m\r\n`,
              ),
          });
          // Output that arrived before the handle resolved.
          starter.onOutput(earlyOutput);
        }
        onFocus();
        // The size may have changed while the process was starting.
        void handle.resize(term.cols, term.rows).catch(() => undefined);
        if (api.isActive) term.focus();
      })
      .catch((err: unknown) => {
        term.write(`\x1b[31mNie udało się uruchomić terminala: ${String(err)}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      starter?.dispose();
      cancelAnimationFrame(frame);
      observer.disconnect();
      activeSub.dispose();
      subscriptions.forEach((s) => s.dispose());
      term.textarea?.removeEventListener("focus", onFocus);
      unregister();
      useTerminalStore.getState().remove(api.id);
      void pty?.kill().catch(() => undefined);
      term.dispose();
      termRef.current = null;
    };
    // Panel identity and launch params are fixed for the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the light / dark theme.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(themeId);
  }, [themeId]);

  // Apply font changes from settings.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontMono;
    term.options.fontSize = fontSize;
  }, [fontMono, fontSize]);

  return (
    <div className="relative h-full w-full bg-lf-editor">
      <div ref={containerRef} className="absolute inset-0 ml-2 mt-1" data-testid="xterm-container" />
      {searchOpen && search && (
        <TerminalSearch
          addon={search}
          onClose={() => {
            setSearchOpen(false);
            search.clearDecorations();
            termRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
