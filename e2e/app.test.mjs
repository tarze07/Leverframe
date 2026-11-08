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

  it("switches to the light theme from the command palette and saves it", async () => {
    await app.chord(KEY.ctrl, KEY.shift, "p");
    await app.waitFor("return !!document.querySelector('[cmdk-input]')");
    await app.type("motyw jasny");
    await sleep(200);
    await app.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
    await app.waitFor("return document.documentElement.dataset.theme === 'light'");
    const settings = JSON.parse(readFileSync(join(env.config, "settings.json"), "utf8"));
    assert.equal(settings.theme, "light");
    assert.equal(settings.projectDir, env.project, "other settings are kept");
  });
});
