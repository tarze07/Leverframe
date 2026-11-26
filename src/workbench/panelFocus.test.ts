import { describe, expect, it } from "vitest";
import { clickedTab, focusPanel, panelFocus } from "./panelFocus";

describe("panel focus (#125)", () => {
  it("uses the panel's own way, else a field in it, else its content", () => {
    let own = 0;
    const off = panelFocus.register("terminal-1", () => own++);
    focusPanel("terminal-1", document.createElement("div"));
    expect(own).toBe(1);
    off();
    expect(panelFocus.has("terminal-1")).toBe(false);

    const content = document.createElement("div");
    content.innerHTML = `<p>tekst</p><input type="hidden"><textarea disabled></textarea><input aria-label="pole">`;
    document.body.append(content);
    focusPanel("other", content);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("pole");

    const plain = document.createElement("div");
    plain.textContent = "nagranie";
    document.body.append(plain);
    focusPanel("plain", plain);
    expect(document.activeElement).toBe(plain);
    expect(plain.getAttribute("tabindex")).toBe("-1");
    content.remove();
    plain.remove();
  });

  it("does not let an old registration remove a newer one", () => {
    const a = () => undefined;
    const b = () => undefined;
    const offA = panelFocus.register("p", a);
    panelFocus.register("p", b);
    offA();
    expect(panelFocus.has("p")).toBe(true);
  });

  it("knows a click choosing a tab from one on its buttons", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="dv-tab"><span class="title">bash</span><div class="dv-default-tab-action">×</div><button aria-label="Zakończ">x</button></div><span class="poza"></span>`;
    const tab = root.querySelector(".dv-tab")!;
    expect(clickedTab(root.querySelector(".title"), root)).toBe(tab);
    expect(clickedTab(tab, root)).toBe(tab);
    expect(clickedTab(root.querySelector(".dv-default-tab-action"), root)).toBeNull();
    expect(clickedTab(root.querySelector("button"), root)).toBeNull();
    expect(clickedTab(root.querySelector(".poza"), root)).toBeNull();
    // A tab of another dock.
    expect(clickedTab(root.querySelector(".title"), document.createElement("div"))).toBeNull();
  });
});
