/**
 * Where the keyboard goes when a panel's tab is chosen (#125): each kind of panel registers how
 * it takes the focus (terminal, editor, conversation); other panels get their first field or
 * their content.
 */
const focusers = new Map<string, () => void>();

export const panelFocus = {
  register(panelId: string, focus: () => void): () => void {
    focusers.set(panelId, focus);
    return () => {
      if (focusers.get(panelId) === focus) focusers.delete(panelId);
    };
  },
  has: (panelId: string) => focusers.has(panelId),
};

const FIELDS = "textarea:not([disabled]), input:not([disabled]):not([type=hidden]), [contenteditable=true], [tabindex]:not([tabindex='-1'])";

/**
 * Gives the keyboard focus to a panel: its own way, else a field in it, else its content. A panel
 * just shown may not take it yet (dockview shows it a moment later), so this tries again on the
 * next frames until the focus is in the panel.
 */
export function focusPanel(panelId: string, content?: HTMLElement | null, attempt = 0) {
  focusOnce(panelId, content);
  const inside = content ? content.contains(document.activeElement) : true;
  if (!inside && attempt < 20) requestAnimationFrame(() => focusPanel(panelId, content, attempt + 1));
}

function focusOnce(panelId: string, content?: HTMLElement | null) {
  const own = focusers.get(panelId);
  if (own) {
    own();
    return;
  }
  if (!content) return;
  const field = content.querySelector<HTMLElement>(FIELDS);
  if (field) {
    field.focus();
    return;
  }
  // Scrolling with the keyboard (arrows, PgUp/PgDn) needs a focused element.
  if (!content.hasAttribute("tabindex")) content.setAttribute("tabindex", "-1");
  content.focus({ preventScroll: true });
}

/**
 * The tab a click chose (not a button in it, e.g. "×"): the browser leaves the focus on the tab,
 * so the chosen panel gets it once dockview has made it active.
 */
export function clickedTab(target: EventTarget | null, root: HTMLElement): Element | null {
  if (!(target instanceof Element)) return null;
  const tab = target.closest(".dv-tab");
  if (!tab || !root.contains(tab)) return null;
  const control = target.closest("button, [role=button], a, input, .dv-default-tab-action");
  return !control || control === tab || !tab.contains(control) ? tab : null;
}
