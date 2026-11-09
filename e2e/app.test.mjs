// End-to-end tests on the real application window (Linux): run with `npm run e2e`
// after `npm run tauri build -- --debug --no-bundle`, inside an X server (e.g. `xvfb-run`).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { App, KEY, startDriver } from "./driver.mjs";
import { makeHome } from "./fixtures.mjs";

const APP = process.env.LEVERFRAME_APP ?? new URL("../src-tauri/target/debug/leverframe", import.meta.url).pathname;
const env = makeHome();
let driver;
let app;

const showView = (label) => app.click("nav button", label);

before(async () => {
  driver = await startDriver({ HOME: env.home, SHELL: "/bin/bash", XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" });
  app = await App.launch(APP);
});

after(async () => {
  if (process.env.E2E_SCREENSHOT && app) writeFileSync(process.env.E2E_SCREENSHOT, await app.screenshot());
  await app?.close();
  driver?.kill();
  // The app may still be writing (database, recordings) while it shuts down.
  try {
    rmSync(env.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`Could not remove ${env.home}: ${e.message}`);
  }
});

describe("Leverframe", () => {
  it("starts a terminal that runs commands in the user's shell", async () => {
    await app.waitFor("return document.querySelectorAll('.xterm').length >= 1", 15_000);
    await app.click(".xterm-helper-textarea").catch(() => {});
    await app.exec("document.querySelector('.xterm-helper-textarea').focus()");
    await app.type(`echo "$TERM:$TERM_PROGRAM" > "$HOME/terminal.txt"${KEY.enter}`);
    const file = join(env.home, "terminal.txt");
    for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
    assert.equal(readFileSync(file, "utf8").trim(), "xterm-256color:Leverframe");
  });

  it("detects an agent from the login shell's PATH and records its session (searchable while running)", async () => {
    await showView("Agenci");
    await app.waitFor("return document.querySelector('li[aria-label=\"Claude Code\"]')?.innerText.includes('9.9.9')", 20_000);
    await app.click('li[aria-label="Claude Code"] button', "Uruchom");
    const ran = join(env.home, "claude-ran.txt");
    for (let i = 0; i < 100 && !existsSync(ran); i++) await sleep(100);
    assert.equal(readFileSync(ran, "utf8").trim(), env.project, "agent started in the project folder");

    // The session is still running: its recording must already be searchable.
    await showView("Sesje");
    await app.click('[role="tab"]', "Nagrania");
    await app.exec(
      "const i=document.querySelector('input[placeholder^=\"Szukaj w wyjściu\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'refactor'); i.dispatchEvent(new Event('input',{bubbles:true}));",
    );
    await app.waitFor("return document.querySelector('ul[aria-label=\"Sesje\"] mark')?.innerText.toLowerCase() === 'refactor'", 15_000);
  });

  it("lists the agents' own conversation logs and shows a timeline", async () => {
    await app.click('[role="tab"]', "Rozmowy");
    await app.waitFor("return document.querySelector('ul[aria-label=\"Rozmowy\"]')?.innerText.includes('Dodaj limit zapytań')", 15_000);
    await app.click('ul[aria-label="Rozmowy"] button', "Napraw testy");
    const commands = await app.waitFor(
      "const l=[...document.querySelectorAll('li[aria-label^=\"Polecenie\"]')]; return l.length ? l.map(x => x.innerText) : null",
    );
    assert.ok(commands.some((c) => c.includes("kod 1")), "failed command shows its exit code");
  });

  it("edits and saves a file; ignored files are hidden", async () => {
    await showView("Pliki");
    const top = await app.waitFor("const t=[...document.querySelectorAll('[role=tree] > li')].map(l => l.getAttribute('aria-label')); return t.length ? t : null");
    assert.ok(top.includes("src") && !top.includes("node_modules"));
    await app.click('[role=treeitem][aria-label="src"] button');
    await app.waitFor("return !!document.querySelector('[role=treeitem][aria-label=\"payments.ts\"]')");
    await app.click('[role=treeitem][aria-label="payments.ts"] button');
    await app.waitFor("return document.querySelector('.view-line')?.innerText.includes('total')", 20_000);
    await app.chord(KEY.ctrl, KEY.end);
    await app.type("\n// e2e");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.includes('● payments.ts'))");
    await app.chord(KEY.ctrl, "s");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === 'payments.ts')");
    assert.match(readFileSync(join(env.project, "src", "payments.ts"), "utf8"), /\/\/ e2e$/);
  });

  it("moves the terminal panel beside the editor and maximizes it; the shell keeps running", async () => {
    const panel = 'section[aria-label="Panel terminala"]';
    const size = (sel) => `const r = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.x), Math.round(r.y)];`;
    // Dockview keeps inactive terminals in the DOM, so the test marks the one it opens.
    const typeInPanel = async (text) => {
      await app.waitFor("const t = document.querySelector('[data-e2e-target]'); t.focus(); return document.activeElement === t");
      await app.type(text);
    };
    const pidAfter = async (name) => {
      const file = join(env.home, name);
      await typeInPanel(`echo $$ > "$HOME/${name}"${KEY.enter}`);
      for (let i = 0; i < 150 && !(existsSync(file) && readFileSync(file, "utf8").trim()); i++) await sleep(100);
      return readFileSync(file, "utf8").trim();
    };

    await app.exec("document.querySelectorAll('.xterm-helper-textarea').forEach(t => { t.dataset.e2eOld = '1'; })");
    await app.chord(KEY.ctrl, KEY.shift, "`");
    await app.waitFor(
      `const t = document.querySelector('${panel} .xterm-helper-textarea:not([data-e2e-old])'); if (t) t.dataset.e2eTarget = '1'; return !!t`,
      15_000,
    );
    const pid = await pidAfter("pid-start.txt");
    assert.match(pid, /^\d+$/);

    await app.click(`${panel} button`, "Przenieś panel obok edytora");
    await app.waitFor(`const e = document.querySelector('[data-testid=dock-main]').getBoundingClientRect(), p = document.querySelector('${panel}').getBoundingClientRect(); return p.x >= e.right - 2 && Math.abs(p.y - e.y) < 2`);

    await app.chord(KEY.ctrl, KEY.shift, "m");
    await app.waitFor(`return document.querySelector('[data-testid=dock-main]').getBoundingClientRect().width === 0`);
    const [panelWidth] = await app.exec(size(panel));
    assert.ok(panelWidth > 400, `panel fills the center (${panelWidth}px)`);
    assert.equal(await pidAfter("pid-max.txt"), pid, "same shell after moving and maximizing");

    await app.click(`${panel} button`, "Przywróć edytor");
    await app.waitFor(`return document.querySelector('[data-testid=dock-main]').getBoundingClientRect().width > 100`);
    await app.click(".dv-tabs-and-actions-container button", "Maksymalizuj edytor");
    await app.waitFor(`return document.querySelector('${panel}').getBoundingClientRect().width === 0`);
    await app.click(".dv-tabs-and-actions-container button", "Przywróć panel terminala");
    await app.click(`${panel} button`, "Przenieś panel pod edytor");
    await app.waitFor(`const e = document.querySelector('[data-testid=dock-main]').getBoundingClientRect(), p = document.querySelector('${panel}').getBoundingClientRect(); return p.width > 0 && p.y >= e.bottom - 2`);
    assert.equal(await pidAfter("pid-end.txt"), pid);
  });

  it("switches themes from the command palette and saves them", async () => {
    const palette = async (query) => {
      await app.chord(KEY.ctrl, KEY.shift, "p");
      await app.waitFor("return !!document.querySelector('[cmdk-input]')");
      await app.type(query);
      await sleep(200);
      await app.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
    };
    const readSettings = () => JSON.parse(readFileSync(join(env.config, "settings.json"), "utf8"));

    await palette("Motyw: Papier");
    await app.waitFor("return document.documentElement.dataset.themeId === 'light-paper'");
    assert.equal(await app.exec("return getComputedStyle(document.documentElement).getPropertyValue('--lf-editor-bg').trim()"), "#fbf7ef");
    for (let i = 0; i < 30 && readSettings().lightTheme !== "light-paper"; i++) await sleep(100);
    let settings = readSettings();
    assert.equal(settings.theme, "light-paper");
    assert.equal(settings.lightTheme, "light-paper");
    assert.equal(settings.projectDir, env.project, "other settings are kept");

    await palette("Przełącz motyw jasny");
    await app.waitFor("return document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.themeId === 'dark'");
    for (let i = 0; i < 30 && readSettings().theme !== "dark"; i++) await sleep(100);
    settings = readSettings();
    assert.equal(settings.theme, "dark");
  });
});
