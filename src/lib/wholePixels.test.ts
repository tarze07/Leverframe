import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWholePixels } from "./wholePixels";

let notify: () => void = () => undefined;
class FakeObserver {
  constructor(cb: () => void) {
    notify = cb;
  }
  observe() {}
  disconnect() {}
}

describe("observeWholePixels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports whole-pixel sizes and ignores sub-pixel jitter", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => (f(), 1));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const el = document.createElement("div");
    let size = { width: 500.4, height: 300.8 };
    el.getBoundingClientRect = () => ({ ...size }) as DOMRect;
    const seen: [number, number][] = [];
    const stop = observeWholePixels(el, (w, h) => seen.push([w, h]));

    notify();
    // 125% scaling: the size flips around a pixel boundary – no new layout.
    for (const width of [499.6, 500.2, 499.8, 500.4]) {
      size = { width, height: 300.8 };
      notify();
    }
    size = { width: 640.2, height: 300.8 };
    notify();
    size = { width: 640.2, height: 0 };
    notify();
    expect(seen).toEqual([
      [500, 300],
      [640, 300],
      [640, 0],
    ]);
    stop();
  });
});
