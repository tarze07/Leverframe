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
    await app.click('[role="tab"]', "Historia");
    await app.exec(
      "const i=document.querySelector('input[placeholder^=\"Szukaj w nagraniach\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'refactor'); i.dispatchEvent(new Event('input',{bubbles:true}));",
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

  it("saves a Markdown file with the toolbar button and shows its preview", async () => {
    const bar = `[...document.querySelectorAll('[aria-label="Pasek edytora"]')].find(b => b.querySelector('span[title$="README.md"]'))`;
    await showView("Pliki");
    await app.waitFor("return !!document.querySelector('[role=treeitem][aria-label=\"README.md\"]')");
    await app.click('[role=treeitem][aria-label="README.md"] button');
    await app.waitFor(`const b = ${bar}; return b && [...b.parentElement.querySelectorAll('.view-line')].some(l => l.innerText.includes('Sklep'))`, 20_000);
    assert.equal(await app.exec(`return ${bar}.querySelector('button[title^="Zapisz"]').disabled`), true, "nothing to save yet");

    await app.chord(KEY.ctrl, KEY.end);
    await app.type("\nDopisane w e2e.");
    await app.waitFor(`return !${bar}.querySelector('button[title^="Zapisz"]').disabled`);
    await app.exec(`${bar}.querySelector('button[title^="Zapisz"]').click()`);
    await app.waitFor(`return ${bar}.querySelector('button[title^="Zapisz"]').disabled`);
    assert.match(readFileSync(join(env.project, "README.md"), "utf8"), /Dopisane w e2e\.\n?$/);
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === 'README.md')");

    await app.exec(`${bar}.querySelector('button[aria-label^="Tylko podgląd"]').click()`);
    const preview = `${bar}.parentElement.querySelector('[data-testid=markdown-preview]')`;
    // textContent, not innerText: the latter is empty while dockview briefly hides the panel's
    // overlay during a layout pass (editors use renderer "always").
    await app.waitFor(`return ${preview}?.querySelector('h1')?.textContent === 'Sklep'`);
    await app.waitFor(`return ${preview}.textContent.includes('Dopisane w e2e.')`);
    // The local image is read through the backend and shown.
    await app.waitFor(`const img = ${preview}.querySelector('img[alt=logo]'); return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth === 2`);
    // A web link must not navigate the app window.
    const before = await app.exec("return location.href");
    await app.exec(`${preview}.querySelector('a').click()`);
    await sleep(300);
    assert.equal(await app.exec("return location.href"), before);

    await app.exec(`${bar}.querySelector('button[aria-label^="Tylko tekst"]').click()`);
    await app.waitFor(`return !${bar}.parentElement.querySelector('[data-testid=markdown-preview]')`);
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

  it("talks to an agent in conversation mode (ACP): prompt, answer, permission, project folder", async () => {
    const chat = "[data-testid=agent-chat]";
    const say = async (text) => {
      await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 20_000);
      await app.waitFor(`const t = document.querySelector('${chat} textarea'); t.focus(); return document.activeElement === t`);
      await app.type(`${text}${KEY.enter}`);
    };
    const transcript = () => app.exec(`return document.querySelector('${chat} [role=log]').textContent`);

    await showView("Agenci");
    await app.waitFor("return document.querySelector('li[aria-label=\"Claude Code\"]')?.textContent.includes('tryb rozmowy dostępny')", 20_000);
    await app.click('li[aria-label="Claude Code"] button', "Rozmowa");
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 30_000);
    assert.match(await app.exec(`return document.querySelector('${chat} header').textContent`), /fake-acp-agent/);

    await say("Witaj z e2e");
    await app.waitFor(`return document.querySelector('${chat} [role=log]').textContent.includes('Echo: Witaj z e2e')`);

    // A permission request answered in the panel.
    await say("permission");
    await app.waitFor(`return !!document.querySelector('${chat} [role=group][aria-label="Prośba o zgodę"]')`);
    await app.click(`${chat} [role=group][aria-label="Prośba o zgodę"] button`, "Zezwól");
    await app.waitFor(`return document.querySelector('${chat} [role=log]').textContent.includes('zgoda: allow')`);
    assert.equal(await app.exec(`return document.querySelectorAll('${chat} [role=group][aria-label="Prośba o zgodę"]').length`), 0);

    // The agent works in the project folder chosen in the app.
    await say("pwd");
    await app.waitFor(`return document.querySelector('${chat} [role=log]').textContent.includes('cwd=')`);
    const text = await transcript();
    assert.ok(text.includes(`cwd=${env.project}`), text);
  });

  it("shows the agent's plan, tool calls, Markdown, usage, commands and modes; stops a turn", async () => {
    const chat = "[data-testid=agent-chat]";
    const has = (text) => `return document.querySelector('${chat} [role=log]').textContent.includes(${JSON.stringify(text)})`;
    const focusBox = () => app.waitFor(`const t = document.querySelector('${chat} textarea'); t.focus(); return document.activeElement === t`);
    const say = async (text) => {
      await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 20_000);
      await focusBox();
      await app.type(`${text}${KEY.enter}`);
    };

    await say("tools");
    // Each turn has its own plan: the last one is this turn's.
    await app.waitFor(`return [...document.querySelectorAll('${chat} [role=group][aria-label="Plan agenta"]')].at(-1)?.textContent.includes('Plan · 2/2')`);
    const card = `${chat} [role=group][aria-label="Narzędzie: Czytam README.md"]`;
    await app.waitFor(`return document.querySelector('${card}')?.textContent.includes('gotowe')`);
    assert.equal(await app.exec(`return document.querySelector('${card} button').textContent`), "README.md:3");
    assert.match(await app.exec(`return document.querySelector('${chat} [role=group][aria-label="Narzędzie: npm test"]').textContent`), /błąd.*1 test nie przeszedł/s);
    await app.waitFor(`return document.querySelector('${chat} [role=log] strong')?.textContent === '1 test'`);
    assert.match(await app.exec(`return document.querySelector('${chat} header').textContent`), /kontekst 12\s300 \/ 200\s000 \(6%\) · 0,42 USD/);
    // A file the agent worked on opens in the editor at its line.
    await app.exec(`document.querySelector('${card} button').click()`);
    await app.waitFor("return [...document.querySelectorAll('.dv-tab.dv-active-tab')].some(t => t.textContent.includes('README.md'))");
    // Dockview activates a tab on pointerdown (a plain click() does not).
    await app.exec(`[...document.querySelectorAll('.dv-tab')].find(t => t.textContent.includes('rozmowa')).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }))`);
    await app.waitFor(`return !!document.querySelector('${chat} textarea')`);

    // The agent's commands after "/".
    await focusBox();
    await app.type("/");
    await app.waitFor(`return [...document.querySelectorAll('${chat} [role=option]')].map(o => o.textContent).join('|').includes('/review')`);
    await app.keys([{ type: "keyDown", value: KEY.escape }, { type: "keyUp", value: KEY.escape }]);
    await app.exec(`const t = document.querySelector('${chat} textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }))`);

    // Mode: the agent confirms the change.
    await app.exec(`const s = document.querySelector('${chat} select[aria-label="Tryb agenta"]'); s.value = 'ask'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
    await app.waitFor(`return document.querySelector('${chat} select[aria-label="Tryb agenta"]').value === 'ask'`);

    // Stop.
    await say("slow");
    await app.waitFor(has("pracuję"));
    await app.click(`${chat} button`, "Stop");
    await app.waitFor(has("Przerwano."));

    await say("limit");
    await app.waitFor(has("limit długości odpowiedzi"));
  });

  it("lets the agent edit a file through the editor: unsaved text, diff, permission key, files outside refused", async () => {
    const chat = "[data-testid=agent-chat]";
    const readmeBar = `[...document.querySelectorAll('[aria-label="Pasek edytora"]')].find(b => b.querySelector('span[title$="README.md"]'))`;
    const activate = (text) =>
      app.exec(`[...document.querySelectorAll('.dv-tab')].find(t => t.textContent.includes(${JSON.stringify(text)})).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }))`);
    const has = (text) => `return document.querySelector('${chat} [role=log]')?.textContent.includes(${JSON.stringify(text)})`;
    const focusBox = () => app.waitFor(`const t = document.querySelector('${chat} textarea'); t.focus(); return document.activeElement === t`);

    // Unsaved text in an open editor.
    await showView("Pliki");
    await app.waitFor("return !!document.querySelector('[role=treeitem][aria-label=\"README.md\"]')");
    await app.click('[role=treeitem][aria-label="README.md"] button');
    await app.waitFor(`const b = ${readmeBar}; return !!b && !!b.parentElement.querySelector('.view-line')`, 20_000);
    await app.waitFor(`const ta = ${readmeBar}.parentElement.querySelector('textarea.inputarea'); ta.focus(); return document.activeElement === ta`);
    await app.chord(KEY.ctrl, KEY.end);
    await app.type("\nNiezapisane z e2e.");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('● README.md'))");
    assert.doesNotMatch(readFileSync(join(env.project, "README.md"), "utf8"), /Niezapisane/);

    // The agent reads it through Leverframe and proposes a change.
    await activate("rozmowa");
    await app.waitFor(`return !!document.querySelector('${chat} textarea')`);
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 20_000);
    await focusBox();
    await app.type(`edit${KEY.enter}`);
    const card = `${chat} [role=group][aria-label="Prośba o zgodę"]`;
    await app.waitFor(`return document.querySelector('${card}')?.textContent.includes('+ Dopisane przez agenta.')`);
    const cardText = await app.exec(`return document.querySelector('${card}').textContent`);
    assert.match(cardText, /Niezapisane z e2e\./, "the agent got the unsaved text");
    assert.match(cardText, /\+1.*−0/);
    assert.match(await app.exec("return document.querySelector('.dv-tab.dv-active-tab')?.textContent ?? ''"), /⚑/, "the tab shows a decision is waiting");

    // The full change in the editor area.
    await app.click(`${card} button`, "Otwórz zmianę");
    await app.waitFor("return !!document.querySelector('[data-testid=monaco-diff] .monaco-diff-editor')", 20_000);
    await activate("rozmowa");
    await app.waitFor(`return !!document.querySelector('${card}')`);

    // Key 1 = the first option ("Zezwól"); the editor gets the change and saves it.
    await focusBox();
    await app.type("1");
    await app.waitFor(has("zapisano"));
    assert.equal(await app.exec(`return document.querySelector('${chat} textarea').value`), "", "the key chose an option, it was not typed");
    const saved = readFileSync(join(env.project, "README.md"), "utf8");
    assert.match(saved, /Niezapisane z e2e\.\nDopisane przez agenta\.\n$/);
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.trim() === 'README.md')");

    // A file outside the project folder: the user decides – here: no.
    await focusBox();
    await app.type(`fs${KEY.enter}`);
    const ask = `${chat} [role=group][aria-label="Dostęp do pliku"]`;
    // Shown with `..` resolved: the file next to the project folder.
    await app.waitFor(`return document.querySelector('${ask}')?.textContent.includes('/projects/poza-projektem.txt')`);
    assert.doesNotMatch(await app.exec(`return document.querySelector('${ask}').textContent`), /\.\./);
    await app.click(`${ask} button`, "Odmów");
    await app.waitFor(has("fs: -32603"));
  });

  it("lets the message box grow with the text, expand and be dragged taller", async () => {
    const chat = "[data-testid=agent-chat]";
    const height = () => app.exec(`return document.querySelector('${chat} textarea').getBoundingClientRect().height`);
    const panel = await app.exec(`return document.querySelector('${chat}').clientHeight`);
    await app.waitFor(`const t = document.querySelector('${chat} textarea'); t.focus(); return document.activeElement === t`);
    const start = await height();
    assert.ok(start < 60, `two lines at first (${start}px)`);

    // Shift+Enter adds lines: the box grows (up to 40% of the panel).
    for (let i = 0; i < 6; i++) {
      await app.type(`linia ${i}`);
      await app.keys([{ type: "keyDown", value: KEY.shift }, { type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }, { type: "keyUp", value: KEY.shift }]);
    }
    const grown = await height();
    assert.ok(grown > start + 40 && grown <= panel * 0.4 + 1, `${start} → ${grown} (panel ${panel})`);

    await app.click(`${chat} button`, "Powiększ pole wiadomości");
    await app.waitFor(`return document.querySelector('${chat} textarea').getBoundingClientRect().height > ${panel * 0.6}`);
    await app.click(`${chat} button`, "Zmniejsz pole wiadomości");
    await app.waitFor(`return Math.abs(document.querySelector('${chat} textarea').getBoundingClientRect().height - ${grown}) < 2`);

    // Dragging the handle above the box up by 120px.
    await app.exec(`
      const h = document.querySelector('${chat} [role=separator]');
      const y = h.getBoundingClientRect().top + 2;
      const ev = (type, clientY) => new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, isPrimary: true, clientY });
      h.dispatchEvent(ev('pointerdown', y));
      h.dispatchEvent(ev('pointermove', y - 120));
      h.dispatchEvent(ev('pointerup', y - 120));`);
    await app.waitFor(`return document.querySelector('${chat} textarea').getBoundingClientRect().height > ${grown + 100}`);
    assert.ok(Number(await app.exec("return localStorage.getItem('leverframe.chat.inputHeight')")) > grown + 100, "remembered");
    // Double click: automatic again.
    await app.exec(`document.querySelector('${chat} [role=separator]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.waitFor(`return Math.abs(document.querySelector('${chat} textarea').getBoundingClientRect().height - ${grown}) < 2`);
    // Leave the box empty for the next test.
    await app.exec(`const t = document.querySelector('${chat} textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }))`);
    await app.waitFor(`return document.querySelector('${chat} textarea').value === ''`);
  });

  it("runs the agent's command after asking: live output in the card and as a terminal, result to the agent", async () => {
    const chat = "[data-testid=agent-chat]";
    const has = (text) => `return document.querySelector('${chat} [role=log]')?.textContent.includes(${JSON.stringify(text)})`;
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 20_000);
    await app.waitFor(`const t = document.querySelector('${chat} textarea'); t.focus(); return document.activeElement === t`);
    await app.type(`run${KEY.enter}`);

    const ask = `${chat} [role=group][aria-label="Polecenie agenta"]`;
    await app.waitFor(`return document.querySelector('${ask}')?.textContent.includes('hello-from-agent')`);
    assert.match(await app.exec(`return document.querySelector('${ask}').textContent`), new RegExp(env.project.replaceAll("/", "\\/")));
    await app.click(`${ask} button`, "Uruchom");

    // The agent got the output and the exit code; the card shows the live terminal.
    await app.waitFor(has("wynik: kod 3"), 20_000);
    assert.match(await app.exec(`return document.querySelector('${chat} [role=log]').textContent`), /hello-from-agent\] po zwolnieniu/);
    const output = `${chat} [aria-label="Wyjście polecenia"]`;
    await app.waitFor(`return document.querySelector('${output}')?.textContent.includes('kod 3')`);
    await app.waitFor(`return document.querySelector('${output} .xterm-rows')?.textContent.includes('hello-from-agent')`);

    // Full size in the terminal panel.
    await app.click(`${output} button`, "Otwórz jako terminal");
    await app.waitFor(`return [...document.querySelectorAll('section[aria-label="Panel terminala"] .xterm-rows')].some(r => r.textContent.includes('hello-from-agent'))`);
  });

  it("finds an ACP conversation in the history by a word from the answer and resumes it", async () => {
    // End the conversation of the previous tests (closing its tab stops the agent).
    await app.exec(`[...document.querySelectorAll('.dv-tab')].filter(t => t.textContent.includes('rozmowa')).forEach(t => t.querySelector('.dv-default-tab-action')?.click())`);
    await app.waitFor("return !document.querySelector('[data-testid=agent-chat]')");

    await showView("Sesje");
    await app.click('[role="tab"]', "Historia");
    await app.exec(
      "const s=document.querySelector('select[aria-label=\"Rodzaj\"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'acp'); s.dispatchEvent(new Event('change',{bubbles:true}));",
    );
    await app.exec(
      "const i=document.querySelector('input[placeholder^=\"Szukaj w nagraniach\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'zgoda'); i.dispatchEvent(new Event('input',{bubbles:true}));",
    );
    const row = 'li[aria-label^="Rozmowa Claude Code"]';
    await app.waitFor(`return document.querySelector('${row} mark')?.textContent.toLowerCase() === 'zgoda'`, 20_000);
    assert.match(await app.exec(`return document.querySelector('${row}').textContent`), /Witaj z e2e/, "titled with the first message");
    assert.equal(await app.exec("return document.querySelectorAll('li[aria-label^=\"Nagranie\"]').length"), 0, "recordings filtered out");
    await app.click(`${row} button`, "Claude Code");

    // Read only, as the conversation ended.
    const chat = "[data-testid=agent-chat]";
    const log = () => app.exec(`return document.querySelector('${chat} [role=log]').textContent`);
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Historia'`, 20_000);
    assert.match(await log(), /Echo: Witaj z e2e[\s\S]*zgoda: allow/);
    assert.equal(await app.exec(`return document.querySelectorAll('${chat} textarea[aria-label="Wiadomość do agenta"]').length`), 0);

    // Resumed: the agent loads its session (its replay is not shown twice) and the talk goes on.
    await app.click(`${chat} [aria-label="Rozmowa z historii"] button`, "Wznów rozmowę");
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 30_000);
    const text = await log();
    assert.match(text, /Rozmowa wznowiona\./);
    assert.equal(text.split("Echo: Witaj z e2e").length, 2, text);
    assert.ok(!text.includes("Napraw testy"), "the agent's replay is hidden");
    await app.waitFor(`const t = document.querySelector('${chat} textarea[aria-label="Wiadomość do agenta"]'); t.focus(); return document.activeElement === t`);
    await app.type(`dalej po przerwie${KEY.enter}`);
    await app.waitFor(`return document.querySelector('${chat} [role=log]').textContent.includes('Echo: dalej po przerwie')`);
  });
});
