/**
 * Watches an element's size and reports it in whole pixels, ignoring changes under one pixel.
 *
 * With fractional display scaling (e.g. 125% on Windows, in a window that is not maximized) sizes
 * are fractional: a terminal or editor that fits itself to every sub-pixel change can resize its
 * contents, round to the other pixel and get notified again, which shows as shaking. Returns a
 * function that stops watching.
 */
export function observeWholePixels(el: HTMLElement, onChange: (width: number, height: number) => void): () => void {
  let last: { width: number; height: number } | null = null;
  let frame = 0;
  const check = () => {
    const rect = el.getBoundingClientRect();
    if (last && Math.abs(rect.width - last.width) < 1 && Math.abs(rect.height - last.height) < 1) return;
    last = { width: rect.width, height: rect.height };
    onChange(Math.floor(rect.width), Math.floor(rect.height));
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(check);
  });
  observer.observe(el);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}
