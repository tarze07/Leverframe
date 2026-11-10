import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown → safe HTML for the preview. GitHub-flavoured Markdown (tables, task lists,
 * strikethrough); raw HTML in the file is sanitized: no scripts, event handlers, iframes,
 * forms or inline styles.
 */
export function renderMarkdown(source: string): string {
  const html = (marked.parse(source, { gfm: true, async: false }) as string)
    // GFM task lists: marked emits disabled checkboxes; show them as symbols (inputs are removed).
    .replace(/<li><input checked="" disabled="" type="checkbox">/g, '<li class="task">☑')
    .replace(/<li><input disabled="" type="checkbox">/g, '<li class="task">☐');
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

/** Directory of a file path (keeps the path's own separator). */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABS = /^[a-z]:[\\/]/i;

/** True for links that leave the app: web pages and e-mail. */
export function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/**
 * Local file a relative link or image points to (`./img/a.png`, `../docs/x.md`, `img%20a.png`),
 * resolved against the folder of the Markdown file. `null` for URLs, data: and in-page anchors.
 */
export function resolveLocalPath(baseDir: string, href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (SCHEME.test(raw) && !WINDOWS_ABS.test(raw)) return null;
  let rel = raw.split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep it as written */
  }
  if (!rel) return null;
  const windows = baseDir.includes("\\") || WINDOWS_ABS.test(baseDir) || WINDOWS_ABS.test(rel);
  const absolute = rel.startsWith("/") || rel.startsWith("\\") || WINDOWS_ABS.test(rel);
  const unc = windows && !absolute && baseDir.startsWith("\\\\");
  const parts: string[] = [];
  // The first part of a Windows path is the drive (or the UNC host and share): ".." stops there.
  const rootParts = windows ? (unc ? 2 : 1) : 0;
  for (const part of `${absolute ? "" : baseDir}/${rel}`.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > rootParts) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return windows ? (unc ? "\\\\" : "") + parts.join("\\") : `/${parts.join("/")}`;
}

/** Monaco language id for a fenced code block's info string (```ts, ```bash, …). */
export function codeLanguage(info: string): string {
  const lang = info.trim().toLowerCase();
  const aliases: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    console: "shell",
    ps1: "powershell",
    pwsh: "powershell",
    py: "python",
    rs: "rust",
    yml: "yaml",
    md: "markdown",
    "c++": "cpp",
    cs: "csharp",
    kt: "kotlin",
    rb: "ruby",
    dockerfile: "dockerfile",
  };
  return aliases[lang] ?? lang;
}
