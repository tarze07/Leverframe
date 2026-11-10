import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openFile } from "../../workbench/commands";
import { codeLanguage, dirName, isExternalLink, renderMarkdown, resolveLocalPath } from "./markdown";
import { monaco } from "./monacoSetup";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
const extension = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";

/** GitHub-style anchor for a heading ("Szybki start!" → "szybki-start"), unique within the page. */
function slug(text: string, used: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s/g, "-") || "sekcja";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/**
 * Sanitized HTML ready for the page: headings get anchors, and local images keep their path in
 * `data-lf-src` (loaded through the backend) instead of a URL the webview would try to fetch.
 */
function prepare(source: string, baseDir: string): string {
  const doc = new DOMParser().parseFromString(`<div>${renderMarkdown(source)}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  const used = new Map<string, number>();
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => (h.id = slug(h.textContent ?? "", used)));
  root.querySelectorAll("img").forEach((img) => {
    const local = resolveLocalPath(baseDir, img.getAttribute("src") ?? "");
    if (local) {
      img.setAttribute("data-lf-src", local);
      img.removeAttribute("src");
    }
  });
  return root.innerHTML;
}

/** Rendered Markdown, updated as the file is edited. Links never navigate the app window. */
export function MarkdownPreview({ source, path }: { source: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const baseDir = dirName(path);
  const html = useMemo(() => prepare(source, baseDir), [source, baseDir]);
  // Image blobs by path, kept while the preview is open (no re-read on every keystroke).
  const images = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    const cache = images.current;
    return () => {
      for (const url of cache.values()) void url.then((u) => u && URL.revokeObjectURL(u));
      cache.clear();
    };
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;

    root.querySelectorAll<HTMLImageElement>("img[data-lf-src]").forEach((img) => {
      const file = img.dataset.lfSrc!;
      let url = images.current.get(file);
      if (!url) {
        url = invoke<ArrayBuffer>("fs_read_image", { path: file })
          .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[extension(file)] ?? "" })))
          .catch(() => null);
        images.current.set(file, url);
      }
      void url.then((u) => {
        if (cancelled) return;
        if (u) img.src = u;
        else img.replaceWith(Object.assign(document.createElement("span"), { className: "lf-md-missing", textContent: `[brak obrazu: ${img.alt || file}]` }));
      });
    });

    root.querySelectorAll<HTMLElement>("pre > code[class*='language-']").forEach((code) => {
      const lang = codeLanguage(/language-(\S+)/.exec(code.className)?.[1] ?? "");
      if (!monaco.languages.getLanguages().some((l) => l.id === lang)) return;
      void monaco.editor
        .colorize((code.textContent ?? "").replace(/\n$/, ""), lang, { tabSize: 2 })
        // Monaco builds this HTML from the code text itself (escaped spans).
        .then((colored) => !cancelled && (code.innerHTML = colored))
        .catch(() => undefined);
    });

    return () => {
      cancelled = true;
    };
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    // The preview lives inside the app window: no link may navigate it.
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      ref.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: "start" });
    } else if (isExternalLink(href)) {
      void openUrl(href).catch(() => undefined);
    } else {
      const local = resolveLocalPath(baseDir, href);
      if (local) openFile(local);
    }
  };

  return (
    <div className="h-full overflow-auto bg-lf-editor" data-testid="markdown-preview">
      <article
        ref={ref}
        className="lf-markdown mx-auto max-w-[860px] px-8 py-6"
        onClick={onClick}
        // Sanitized by DOMPurify in renderMarkdown().
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
