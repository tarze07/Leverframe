import { memo, useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isExternalLink, renderMarkdown } from "../editor/markdown";
import { openFile } from "../../workbench/commands";

/**
 * An agent's answer as Markdown, sanitized like the Markdown preview (no scripts, handlers,
 * iframes, forms or inline styles). Links never navigate the app window: web links open in the
 * browser, paths in the editor (when the file is reachable from this machine).
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, toLocal }: { text: string; toLocal: (path: string) => string | null }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (isExternalLink(href)) void openUrl(href).catch(() => undefined);
    else if (href && !href.startsWith("#")) {
      const local = toLocal(decodeURIComponent(href));
      if (local) openFile(local);
    }
  };
  // Sanitized by DOMPurify in renderMarkdown().
  return <div className="lf-markdown lf-chat-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
