/**
 * Color themes. Each theme sets the app's design tokens (CSS variables used by all components),
 * the terminal's ANSI palette and the editor colors, so one choice restyles the whole window.
 */

export type ThemeKind = "dark" | "light";

/** Values of the `--lf-*` CSS variables (see theme/index.css). */
export interface ThemeTokens {
  bg: string; // activity bar, title bar
  sidebar: string;
  editor: string;
  panel: string;
  elevated: string;
  hover: string;
  border: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  accentFg: string;
  statusbar: string;
  statusbarFg: string;
  danger: string;
  selection: string;
}

/** Terminal ANSI colors: normal 0–7, then bright 8–15. */
export type AnsiPalette = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
];

export interface ThemeDef {
  id: string;
  name: string;
  kind: ThemeKind;
  tokens: ThemeTokens;
  ansi: AnsiPalette;
}

const DARK_ANSI: AnsiPalette = [
  "#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dae0",
  "#5c6370", "#ef7a84", "#a5d68a", "#f0cd8a", "#74bdfa", "#d48fe8", "#66c8d4", "#ffffff",
];

const LIGHT_ANSI: AnsiPalette = [
  "#383a42", "#c4302b", "#3f8f2f", "#9a6700", "#2b62d6", "#a626a4", "#0e7c86", "#8a8f98",
  "#5c6370", "#e45649", "#50a14f", "#b08800", "#4078f2", "#c74ded", "#0997b3", "#24292f",
];

export const THEMES: readonly ThemeDef[] = [
  {
    id: "dark",
    name: "Ciemny",
    kind: "dark",
    tokens: {
      bg: "#181a1f", sidebar: "#1e2127", editor: "#23272e", panel: "#1e2127", elevated: "#2c313a",
      hover: "#2c313a", border: "#2f343d", fg: "#d7dae0", muted: "#8b919c", subtle: "#5c6370",
      accent: "#4d9cf8", accentFg: "#ffffff", statusbar: "#1e2127", statusbarFg: "#9da5b4",
      danger: "#e5534b", selection: "#3e4451",
    },
    ansi: DARK_ANSI,
  },
  {
    id: "dark-midnight",
    name: "Północ",
    kind: "dark",
    tokens: {
      bg: "#0f1420", sidebar: "#141a29", editor: "#182032", panel: "#141a29", elevated: "#222b40",
      hover: "#222b40", border: "#263049", fg: "#c8d3f5", muted: "#8792b4", subtle: "#56607d",
      accent: "#7aa2f7", accentFg: "#0f1420", statusbar: "#141a29", statusbarFg: "#8792b4",
      danger: "#f7768e", selection: "#2d3a5c",
    },
    ansi: [
      "#2a3148", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c8d3f5",
      "#56607d", "#ff8fa3", "#addb7f", "#edc282", "#8fb3ff", "#cbb0ff", "#96dbff", "#ffffff",
    ],
  },
  {
    id: "dark-graphite",
    name: "Grafit",
    kind: "dark",
    tokens: {
      bg: "#161616", sidebar: "#1c1c1c", editor: "#212121", panel: "#1c1c1c", elevated: "#2b2b2b",
      hover: "#2b2b2b", border: "#303030", fg: "#dcdcdc", muted: "#9a9a9a", subtle: "#646464",
      accent: "#e0a040", accentFg: "#161616", statusbar: "#1c1c1c", statusbarFg: "#9a9a9a",
      danger: "#e5534b", selection: "#3a3a3a",
    },
    ansi: [
      "#3a3a3a", "#e06c6c", "#9cc47a", "#e0b860", "#6fa8dc", "#c38fd6", "#5fbfbf", "#dcdcdc",
      "#6a6a6a", "#f08080", "#b0d890", "#f0cc7a", "#8bbcea", "#d4a6e4", "#78d0d0", "#ffffff",
    ],
  },
  {
    id: "dark-forest",
    name: "Las",
    kind: "dark",
    tokens: {
      bg: "#121a16", sidebar: "#16201b", editor: "#1a2620", panel: "#16201b", elevated: "#24332b",
      hover: "#24332b", border: "#283a30", fg: "#d3e2d8", muted: "#8fa597", subtle: "#5a6f62",
      accent: "#5fc58e", accentFg: "#0f1713", statusbar: "#16201b", statusbarFg: "#8fa597",
      danger: "#e5685b", selection: "#2e4538",
    },
    ansi: [
      "#2c3a32", "#e57a6e", "#8fd18c", "#d9c27a", "#6aaed6", "#c08ad0", "#5cc4b4", "#d3e2d8",
      "#5a6f62", "#f08f84", "#a6e0a2", "#e8d290", "#84c0e4", "#d2a2e0", "#78d6c8", "#ffffff",
    ],
  },
  {
    id: "dark-plum",
    name: "Śliwka",
    kind: "dark",
    tokens: {
      bg: "#17121e", sidebar: "#1d1726", editor: "#221b2d", panel: "#1d1726", elevated: "#2e253b",
      hover: "#2e253b", border: "#352b44", fg: "#e0d6ec", muted: "#a093b3", subtle: "#6a5e7d",
      accent: "#c58af9", accentFg: "#17121e", statusbar: "#1d1726", statusbarFg: "#a093b3",
      danger: "#f07178", selection: "#3d3150",
    },
    ansi: [
      "#352b44", "#f07178", "#a8d68a", "#ecc48d", "#82aaff", "#c792ea", "#89ddff", "#e0d6ec",
      "#6a5e7d", "#ff8b92", "#bce4a2", "#f5d4a6", "#9cbcff", "#d8acf2", "#a6e6ff", "#ffffff",
    ],
  },
  {
    id: "dark-contrast",
    name: "Wysoki kontrast",
    kind: "dark",
    tokens: {
      bg: "#000000", sidebar: "#000000", editor: "#000000", panel: "#000000", elevated: "#1a1a1a",
      hover: "#262626", border: "#6b6b6b", fg: "#ffffff", muted: "#d0d0d0", subtle: "#a0a0a0",
      accent: "#ffd000", accentFg: "#000000", statusbar: "#000000", statusbarFg: "#ffffff",
      danger: "#ff5c5c", selection: "#264f78",
    },
    ansi: [
      "#4d4d4d", "#ff5c5c", "#5cff7a", "#ffe44d", "#5ca8ff", "#ff7aff", "#5cf2ff", "#e6e6e6",
      "#8c8c8c", "#ff8080", "#8cff9e", "#fff080", "#8cc2ff", "#ff9eff", "#8cf7ff", "#ffffff",
    ],
  },
  {
    id: "light",
    name: "Jasny",
    kind: "light",
    tokens: {
      bg: "#e9eaed", sidebar: "#f3f4f6", editor: "#ffffff", panel: "#f3f4f6", elevated: "#ffffff",
      hover: "#e2e4e8", border: "#d6d8dd", fg: "#24292f", muted: "#57606a", subtle: "#8c959f",
      accent: "#0969da", accentFg: "#ffffff", statusbar: "#e9eaed", statusbarFg: "#57606a",
      danger: "#cf222e", selection: "#c8d7f5",
    },
    ansi: LIGHT_ANSI,
  },
  {
    id: "light-paper",
    name: "Papier",
    kind: "light",
    tokens: {
      bg: "#ebe4d6", sidebar: "#f2ecdf", editor: "#fbf7ef", panel: "#f2ecdf", elevated: "#fffdf8",
      hover: "#e6dece", border: "#d9cfbc", fg: "#3b3328", muted: "#6e6352", subtle: "#9c907c",
      accent: "#b5651d", accentFg: "#ffffff", statusbar: "#ebe4d6", statusbarFg: "#6e6352",
      danger: "#b3261e", selection: "#ead8b8",
    },
    ansi: [
      "#3b3328", "#b3402e", "#5b7d24", "#94650a", "#2f62a8", "#985098", "#2a7a78", "#8a7f6c",
      "#6e6352", "#c8553f", "#6f9230", "#a9761a", "#3f76c0", "#ad63ad", "#348f8c", "#3b3328",
    ],
  },
  {
    id: "light-sky",
    name: "Błękit",
    kind: "light",
    tokens: {
      bg: "#e1e9f3", sidebar: "#edf2f8", editor: "#f8fbff", panel: "#edf2f8", elevated: "#ffffff",
      hover: "#dce6f2", border: "#cbd7e6", fg: "#1f2d3d", muted: "#4f6175", subtle: "#8597ab",
      accent: "#1f6fd1", accentFg: "#ffffff", statusbar: "#e1e9f3", statusbarFg: "#4f6175",
      danger: "#c8323a", selection: "#c6dbf5",
    },
    ansi: LIGHT_ANSI,
  },
  {
    id: "light-mint",
    name: "Mięta",
    kind: "light",
    tokens: {
      bg: "#e0ede6", sidebar: "#ecf5f0", editor: "#f7fcf9", panel: "#ecf5f0", elevated: "#ffffff",
      hover: "#d9e9e0", border: "#c7dccf", fg: "#1f3329", muted: "#4d6658", subtle: "#87a092",
      accent: "#13855c", accentFg: "#ffffff", statusbar: "#e0ede6", statusbarFg: "#4d6658",
      danger: "#c4302b", selection: "#c4e5d3",
    },
    ansi: LIGHT_ANSI,
  },
  {
    id: "light-mist",
    name: "Mgła",
    kind: "light",
    tokens: {
      bg: "#dfe1e5", sidebar: "#e8eaee", editor: "#eff1f4", panel: "#e8eaee", elevated: "#f7f8fa",
      hover: "#d8dbe0", border: "#cdd1d8", fg: "#2e3440", muted: "#5b6372", subtle: "#8a92a0",
      accent: "#5e81ac", accentFg: "#ffffff", statusbar: "#dfe1e5", statusbarFg: "#5b6372",
      danger: "#bf3f4a", selection: "#cfd8e6",
    },
    ansi: LIGHT_ANSI,
  },
];

export const DEFAULT_DARK_THEME = "dark";
export const DEFAULT_LIGHT_THEME = "light";

const byId = new Map(THEMES.map((t) => [t.id, t]));

export function themeById(id: string | undefined | null): ThemeDef | undefined {
  return id ? byId.get(id) : undefined;
}

/**
 * Theme in effect. `setting` is a theme id or "system"; in system mode the OS preference picks
 * between `darkTheme` and `lightTheme`. Unknown ids fall back to the default of their kind.
 */
export function resolveTheme(setting: string, darkTheme: string, lightTheme: string, osPrefersLight: boolean): ThemeDef {
  const fallback = (kind: ThemeKind) => byId.get(kind === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME)!;
  const pick = (id: string, kind: ThemeKind) => {
    const t = byId.get(id);
    return t && t.kind === kind ? t : fallback(kind);
  };
  if (setting === "system") return osPrefersLight ? pick(lightTheme, "light") : pick(darkTheme, "dark");
  return byId.get(setting) ?? fallback(setting.startsWith("light") ? "light" : "dark");
}

/** CSS variables for a theme (applied inline on <html>). */
export function themeCssVariables(t: ThemeDef): Record<string, string> {
  const k = t.tokens;
  return {
    "--lf-bg": k.bg,
    "--lf-sidebar-bg": k.sidebar,
    "--lf-editor-bg": k.editor,
    "--lf-panel-bg": k.panel,
    "--lf-elevated": k.elevated,
    "--lf-hover": k.hover,
    "--lf-border": k.border,
    "--lf-fg": k.fg,
    "--lf-fg-muted": k.muted,
    "--lf-fg-subtle": k.subtle,
    "--lf-accent": k.accent,
    "--lf-accent-fg": k.accentFg,
    "--lf-statusbar-bg": k.statusbar,
    "--lf-statusbar-fg": k.statusbarFg,
    "--lf-danger": k.danger,
  };
}
