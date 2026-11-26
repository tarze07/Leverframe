// End-to-end tests on the real application window (Linux): run with `npm run e2e`
// after `npm run tauri build -- --debug --no-bundle`, inside an X server (e.g. `xvfb-run`).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("draws the interface instead of the start screen (#115)", async () => {
    await app.waitFor("return !!document.querySelector('nav[aria-label=\"Activity bar\"]')", 15_000);
    assert.equal(await app.exec("return document.getElementById('lf-start')"), null, "the start screen is gone");
    assert.equal(await app.exec("return document.visibilityState"), "visible");
  });

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

    // #101: the conversation is copied as Markdown (read back through the app's clipboard).
    const clipboard = "return window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|read_text')";
    await app.exec("document.querySelector('button[aria-label=\"Kopiuj rozmowę\"]').click()");
    await app.waitFor("return document.querySelector('button[aria-label=\"Kopiuj rozmowę\"]').textContent.includes('Skopiowano')");
    const md = await app.exec(clipboard);
    assert.match(md, /^# Napraw testy/);
    assert.match(md, /\*\*Polecenie\*\*/);
    // The text of the timeline can be selected.
    assert.equal(
      await app.exec("const st = getComputedStyle(document.querySelector('ol[aria-label=\"Oś czasu\"] p.select-text')); return st.userSelect || st.webkitUserSelect"),
      "text",
    );

    // The recorded session: its terminal text up to now (opened from a search: at the end).
    await app.click('[role="tab"]', "Historia");
    await app.exec(
      "const i=document.querySelector('input[placeholder^=\"Szukaj w nagraniach\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'refactor'); i.dispatchEvent(new Event('input',{bubbles:true}));",
    );
    await app.waitFor("return !!document.querySelector('ul[aria-label=\"Sesje\"] mark')", 15_000);
    await app.exec("document.querySelector('ul[aria-label=\"Sesje\"] mark').closest('button').click()");
    await app.waitFor("return !!document.querySelector('button[aria-label=\"Kopiuj tekst terminala\"]')", 15_000);
    await app.waitFor("return document.querySelector('[data-testid=player-terminal]')?.textContent.toLowerCase().includes('refactor')", 15_000);
    await app.exec("document.querySelector('button[aria-label=\"Kopiuj tekst terminala\"]').click()");
    await app.waitFor("return document.querySelector('button[aria-label=\"Kopiuj tekst terminala\"]').textContent.includes('Skopiowano')");
    assert.match((await app.exec(clipboard)).toLowerCase(), /refactor/);
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
    await app.type(`${KEY.enter}// e2e`);
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.includes('● payments.ts'))");
    // The editor's own styles apply (a CSP with hashes refused them: no colors, lines drawn over
    // each other): tokens in several colors, the new line under the others.
    await app.waitFor("return new Set([...document.querySelectorAll('.view-line span span')].map(s => getComputedStyle(s).color)).size >= 3", 10_000);
    await app.waitFor("return [...document.querySelectorAll('.line-numbers')].some(n => n.textContent.trim() === '3')");
    await app.waitFor("return [...document.querySelectorAll('.view-line')].some(l => l.innerText.replace(/\\u00a0/g, ' ').trim() === '// e2e')");
    const tops = await app.exec("return [...document.querySelectorAll('.view-line')].map(l => [l.innerText.replace(/\\u00a0/g, ' ').trim(), l.getBoundingClientRect().top])");
    const first = tops.find(([t]) => t.startsWith("export"))?.[1];
    const added = tops.find(([t]) => t === "// e2e")?.[1];
    assert.ok(first !== undefined && added > first + 10, `the new line is drawn under the first one: ${JSON.stringify(tops)}`);
    await app.chord(KEY.ctrl, "s");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === 'payments.ts')");
    assert.match(readFileSync(join(env.project, "src", "payments.ts"), "utf8"), /\/\/ e2e$/);
  });

  it("creates and deletes files and folders in the file tree (#97)", async () => {
    await showView("Pliki");
    const item = (name) => `[role=treeitem][aria-label="${name}"]`;
    const create = async (button, name) => {
      await app.exec(`document.querySelector('button[aria-label="${button}"]').click()`);
      await app.waitFor("return !!document.querySelector('form[aria-label^=\"Nowy \"] input')");
      await app.exec(
        `const i = document.querySelector('form[aria-label^="Nowy "] input');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[0]);
         i.dispatchEvent(new Event('input', { bubbles: true }));`,
        [name],
      );
      await app.exec(`document.querySelector('form[aria-label^="Nowy "] button[type=submit]').click()`);
      await app.waitFor("return !document.querySelector('form[aria-label^=\"Nowy \"]')");
    };
    const remove = async (name, choice) => {
      await app.exec(`document.querySelector('${item(name)} button[aria-label="Usuń ${name}"]').click()`);
      await app.waitFor(`return !!document.querySelector('[role=group][aria-label="Usuwanie ${name}"]')`);
      await app.exec(
        `[...document.querySelectorAll('[role=group][aria-label="Usuwanie ${name}"] button')].find(b => b.textContent.trim() === arguments[0]).click()`,
        [choice],
      );
      await app.waitFor(`return !document.querySelector('${item(name)}')`, 20_000);
    };

    // New entries go to the last folder clicked: src.
    await app.waitFor(`return !!document.querySelector('${item("src")}')`);
    await app.exec(`document.querySelector('${item("src")} button').click()`);
    const base = join(env.project, "src");
    await create("Nowy folder…", "notatki/robocze");
    assert.ok(existsSync(join(base, "notatki", "robocze")), "the folder and the one on the way");
    await create("Nowy plik…", "notatki/plan.md");
    assert.equal(readFileSync(join(base, "notatki", "plan.md"), "utf8"), "");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === 'plan.md')", 20_000);
    await app.waitFor(`return !!document.querySelector('${item("plan.md")}')`);

    // To the trash: gone from the folder, in the user's trash, its editor closed.
    await remove("plan.md", "Do kosza");
    assert.equal(existsSync(join(base, "notatki", "plan.md")), false);
    assert.ok(existsSync(join(env.home, ".local", "share", "Trash", "files", "plan.md")), "in the trash");
    await app.waitFor("return ![...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === 'plan.md')");

    // A folder with its contents, permanently.
    await remove("notatki", "Usuń na stałe");
    assert.equal(existsSync(join(base, "notatki")), false);
  });

  it("keeps tasks in the project and globally: create, status, move, delete (#106)", async () => {
    const tasksDir = join(env.project, ".leverframe", "tasks");
    const globalDir = join(env.home, ".local", "share", "io.github.tarze07.leverframe", "tasks");
    // The project as a git repository: its tasks stay out of it (.git/info/exclude).
    mkdirSync(join(env.project, ".git"), { recursive: true });
    const task = (title) => `li[aria-label$=" ${title}"]`;
    const inGroup = (group, title) => `return !!document.querySelector('ul[aria-label="Zadania: ${group}"] ${task(title)}')`;
    const create = async (title) => {
      await app.exec(`document.querySelector('button[aria-label="Nowe zadanie…"]').click()`);
      await app.waitFor("return !!document.querySelector('form[aria-label=\"Nowe zadanie\"] input')");
      await app.exec(
        `const i = document.querySelector('form[aria-label="Nowe zadanie"] input');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[0]);
         i.dispatchEvent(new Event('input', { bubbles: true }));`,
        [title],
      );
      await app.exec(`document.querySelector('form[aria-label="Nowe zadanie"] button[type=submit]').click()`);
      await app.waitFor("return !document.querySelector('form[aria-label=\"Nowe zadanie\"]')");
    };
    const menu = async (title, entry) => {
      await app.exec(`document.querySelector('button[aria-label="Więcej: ${title}"]').click()`);
      await app.waitFor("return !!document.querySelector('[role=menu]')");
      await app.click("[role=menu] [role=menuitem]", entry);
    };
    const remove = async (title, choice) => {
      await menu(title, "Usuń…");
      await app.waitFor("return !!document.querySelector('[role=group][aria-label^=\"Usuwanie zadania\"]')");
      await app.click('[role=group][aria-label^="Usuwanie zadania"] button', choice);
      await app.waitFor(`return !document.querySelector('${task(title)}')`, 20_000);
    };
    const tab = (name) => `return [...document.querySelectorAll('.dv-tab')].some(t => t.innerText.trim() === '${name}')`;

    try {
      await showView("Zadania");
      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await app.waitFor("return document.body.innerText.includes('Brak zadań')", 20_000);
      await create("Eksport do CSV: „pilne”");
      const file = join(tasksDir, "1-eksport-do-csv-pilne.md");
      assert.match(readFileSync(file, "utf8"), /^---\nid: 1\ntitle: "Eksport do CSV: „pilne”"\nstatus: todo\n/);
      await app.waitFor(tab("1-eksport-do-csv-pilne.md"), 20_000);
      await app.waitFor(inGroup("Do zrobienia", "Eksport do CSV: „pilne”"));
      assert.match(readFileSync(join(env.project, ".git", "info", "exclude"), "utf8"), /^\/\.leverframe\/$/m);
      assert.equal(readFileSync(join(env.project, ".gitignore"), "utf8"), "node_modules/\n", ".gitignore unchanged");

      await menu("Eksport do CSV: „pilne”", "W toku");
      await app.waitFor(inGroup("W toku", "Eksport do CSV: „pilne”"));
      assert.match(readFileSync(file, "utf8"), /\nstatus: doing\n/);

      // A title changed in the file shows after a refresh.
      writeFileSync(file, readFileSync(file, "utf8").replace('title: "Eksport do CSV: „pilne”"', "title: Eksport CSV i XLSX"));
      await app.exec(`document.querySelector('aside[aria-label="Zadania"] button[aria-label="Odśwież"]').click()`);
      await app.waitFor(inGroup("W toku", "Eksport CSV i XLSX"));

      // A global task, moved to the project.
      await app.click('[aria-label="Lista zadań"] button', "Globalne");
      await app.waitFor("return document.body.innerText.includes('Brak zadań')", 20_000);
      await create("Wspólne narzędzia");
      assert.ok(existsSync(join(globalDir, "1-wspolne-narzedzia.md")), "in the app's data folder");
      await app.waitFor(inGroup("Do zrobienia", "Wspólne narzędzia"));
      await menu("Wspólne narzędzia", "Przenieś do projektu");
      await app.waitFor(`return !document.querySelector('${task("Wspólne narzędzia")}')`);
      assert.equal(existsSync(join(globalDir, "1-wspolne-narzedzia.md")), false);
      assert.match(readFileSync(join(tasksDir, "2-wspolne-narzedzia.md"), "utf8"), /^---\nid: 2\n/);
      await app.waitFor(`return !(${tab("1-wspolne-narzedzia.md").slice(7)})`);

      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await app.waitFor(inGroup("Do zrobienia", "Wspólne narzędzia"), 20_000);
      await remove("Wspólne narzędzia", "Usuń na stałe");
      assert.equal(existsSync(join(tasksDir, "2-wspolne-narzedzia.md")), false);
      await remove("Eksport CSV i XLSX", "Do kosza");
      assert.equal(existsSync(file), false);
      assert.ok(existsSync(join(env.home, ".local", "share", "Trash", "files", "1-eksport-do-csv-pilne.md")), "in the trash");
      await app.waitFor(`return !(${tab("1-eksport-do-csv-pilne.md").slice(7)})`);
    } finally {
      rmSync(join(env.project, ".git"), { recursive: true, force: true });
      rmSync(join(env.project, ".leverframe"), { recursive: true, force: true });
    }
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

    // Side by side: the editor fills its half and nothing keeps resizing (#scaling: the editor is
    // laid out in whole pixels, see lib/wholePixels.ts).
    const fits = `const c = ${bar}.parentElement.querySelector('[data-testid=monaco-container]'); const e = c.querySelector('.monaco-editor');
      const a = c.getBoundingClientRect(), b = e.getBoundingClientRect(); return a.width > 50 && Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5`;
    const sizes = `return [...${bar}.parentElement.querySelectorAll('[data-testid=monaco-container] .monaco-editor, [data-testid=markdown-preview], [data-testid=markdown-preview] > *')].map(e => { const r = e.getBoundingClientRect(); return r.width + 'x' + r.height; }).join(' ')`;
    await app.exec(`${bar}.querySelector('button[aria-label^="Tekst i podgląd"]').click()`);
    await app.waitFor(`return !!${preview}`);
    await app.waitFor(fits);
    const first = await app.exec(sizes);
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      assert.equal(await app.exec(sizes), first, "the editor and the preview keep their size");
    }

    await app.exec(`${bar}.querySelector('button[aria-label^="Tylko tekst"]').click()`);
    await app.waitFor(`return !${bar}.parentElement.querySelector('[data-testid=markdown-preview]')`);
    // Back from the preview (the editor was hidden): it fills the whole width again.
    await app.waitFor(fits);
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

    // A new terminal does not change the layout: the maximized panel stays maximized.
    const editorHidden = "const r = document.querySelector('[data-testid=dock-main]').getBoundingClientRect(); return r.width === 0 || r.height === 0";
    await app.chord(KEY.ctrl, KEY.shift, "m");
    await app.waitFor(editorHidden);
    const terminals = await app.exec("return document.querySelectorAll('.xterm').length");
    await app.chord(KEY.ctrl, KEY.shift, "`");
    await app.waitFor(`return document.querySelectorAll('.xterm').length > ${terminals}`, 15_000);
    await sleep(300);
    assert.equal(await app.exec(editorHidden), true, "still maximized");
    await app.chord(KEY.ctrl, KEY.shift, "m");
    await app.waitFor(editorHidden.replace("return r.width === 0 || r.height === 0", "return r.width > 100 && r.height > 50"));
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

  it("switches to the system's window frame and back (setting windowFrame)", async () => {
    const readSettings = () => JSON.parse(readFileSync(join(env.config, "settings.json"), "utf8"));
    const titleBar = "return !!document.querySelector('header[data-tauri-drag-region]')";
    const choose = (value) =>
      app.exec(
        `const l = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'Ramka okna');
         const s = document.getElementById(l.htmlFor);
         Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, arguments[0]);
         s.dispatchEvent(new Event('change', { bubbles: true }));`,
        [value],
      );
    await showView("Ustawienia");
    await app.waitFor("return [...document.querySelectorAll('label')].some(l => l.textContent.trim() === 'Ramka okna')");
    assert.equal(await app.exec(titleBar), true, "Leverframe's title bar by default");
    await choose("system");
    await app.waitFor("return !document.querySelector('header[data-tauri-drag-region]')");
    for (let i = 0; i < 30 && readSettings().windowFrame !== "system"; i++) await sleep(100);
    assert.equal(readSettings().windowFrame, "system");
    await choose("custom");
    await app.waitFor(titleBar);
    for (let i = 0; i < 30 && readSettings().windowFrame !== "custom"; i++) await sleep(100);
    assert.equal(readSettings().windowFrame, "custom");
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
    // The tab shows a decision is waiting.
    await app.waitFor("return (document.querySelector('.dv-tab.dv-active-tab')?.textContent ?? '').includes('⚑')");

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
    // Closing the tab keeps the conversation: it is in the "Rozmowy" view and opens again as it was.
    await app.exec(`[...document.querySelectorAll('.dv-tab')].filter(t => t.textContent.includes('rozmowa')).forEach(t => t.querySelector('.dv-default-tab-action')?.click())`);
    await app.waitFor("return !document.querySelector('[data-testid=agent-chat]')");
    await showView("Rozmowy");
    const listed = 'ul[aria-label="Otwarte rozmowy"] li';
    await app.waitFor(`return document.querySelector('${listed}')?.textContent.includes('Witaj z e2e')`);
    assert.match(await app.exec(`return document.querySelector('${listed}').textContent`), /Gotowy/, "the agent still runs");
    await app.click(`${listed} button`, "fake-acp-agent");
    await app.waitFor("return document.querySelector('[data-testid=agent-chat] [role=log]')?.textContent.includes('Echo: Witaj z e2e')");
    // Shown from its end; scrolled up, a click on its tab goes back to the end.
    const atEnd = "const l = document.querySelector('[data-testid=agent-chat] [role=log]'); return l.scrollHeight - l.scrollTop - l.clientHeight < 4";
    await app.waitFor(atEnd);
    await app.exec("document.querySelector('[data-testid=agent-chat] [role=log]').scrollTop = 0");
    assert.equal(await app.exec(atEnd.replace("return ", "return !(") + ")"), true, "scrolled up");
    await app.click(".dv-tab [data-testid=dockview-dv-default-tab]", "rozmowa");
    await app.waitFor(atEnd);

    // Ending it in the list stops the agent and closes its tab.
    await app.click(`${listed} button[aria-label="Zakończ rozmowę"]`);
    await app.waitFor("return !document.querySelector('[data-testid=agent-chat]')");
    await app.waitFor(`return !document.querySelector('${listed}')`);

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

  it("leaves the file as it was when the change is refused, and reports a crash of the agent", async () => {
    const chat = "[data-testid=agent-chat]";
    const box = `${chat} textarea[aria-label="Wiadomość do agenta"]`;
    const has = (text) => `return document.querySelector('${chat} [role=log]')?.textContent.includes(${JSON.stringify(text)})`;
    const say = async (text) => {
      await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 20_000);
      await app.waitFor(`const t = document.querySelector('${box}'); t.focus(); return document.activeElement === t`);
      await app.type(`${text}${KEY.enter}`);
    };

    // The diff refused: the agent reports it, the file stays unchanged.
    const before = readFileSync(join(env.project, "README.md"), "utf8");
    await say("edit");
    const card = `${chat} [role=group][aria-label="Prośba o zgodę"]`;
    await app.waitFor(`return document.querySelector('${card}')?.textContent.includes('+ Dopisane przez agenta.')`);
    await app.click(`${card} button`, "Odmów");
    await app.waitFor(has("odmowa"));
    assert.equal(readFileSync(join(env.project, "README.md"), "utf8"), before);

    // A change the agent makes with its own tool (like Claude's Edit): the open editor shows it.
    const readmeBar = `[...document.querySelectorAll('[aria-label="Pasek edytora"]')].find(b => b.querySelector('span[title$="README.md"]'))`;
    await say("selfedit");
    await app.waitFor(has("zmieniono bezpośrednio"));
    await app.waitFor(`return ${readmeBar}?.parentElement.querySelector('.view-lines')?.textContent.replaceAll('\\u00a0', ' ').includes('Zmienione bezpośrednio przez agenta.')`, 20_000);
    assert.ok(!(await app.exec("return [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('● README.md'))")), "not unsaved");

    // The agent crashes: its last words and the end are shown; nothing more can be sent.
    await say("crash");
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Agent zakończył działanie'`, 20_000);
    assert.match(await app.exec(`return document.querySelector('${chat} [role=alert]')?.textContent ?? ''`), /awaria podczas pracy/);
    assert.equal(await app.exec(`return document.querySelector('${box}').disabled`), true);

    // The history keeps the conversation with its exit code.
    await app.exec(
      "const i=document.querySelector('input[placeholder^=\"Szukaj w nagraniach\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'dalej po przerwie'); i.dispatchEvent(new Event('input',{bubbles:true}));",
    );
    await app.waitFor("return document.querySelector('li[aria-label^=\"Rozmowa Claude Code\"]')?.textContent.includes('kod 3')", 20_000);
  });
  it("starts an agent on a task: conversation with the file, terminal with the message, history, statuses (#107, #109)", async () => {
    const chat = "[data-testid=agent-chat]";
    const tasksDir = join(env.project, ".leverframe", "tasks");
    const file = join(tasksDir, "1-agent-na-zadaniu.md");
    const title = "Agent na zadaniu";
    const waitFile = async (pattern, timeout = 20_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (existsSync(file) && pattern.test(readFileSync(file, "utf8"))) return;
        await sleep(150);
      }
      assert.fail(`${file} does not match ${pattern}: ${existsSync(file) ? readFileSync(file, "utf8") : "(none)"}`);
    };
    const openRunForm = async () => {
      await app.exec(`document.querySelector('button[aria-label="Uruchom agenta: ${title}"]').click()`);
      await app.waitFor(`return !!document.querySelector('[role=group][aria-label="Uruchom agenta: zadanie #1"]')`);
    };
    try {
      await showView("Zadania");
      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await app.waitFor("return !!document.querySelector('button[aria-label=\"Nowe zadanie…\"]:not([disabled])')", 20_000);
      await app.exec(`document.querySelector('button[aria-label="Nowe zadanie…"]').click()`);
      await app.waitFor("return !!document.querySelector('form[aria-label=\"Nowe zadanie\"] input')");
      await app.exec(
        `const i = document.querySelector('form[aria-label="Nowe zadanie"] input');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[0]);
         i.dispatchEvent(new Event('input', { bubbles: true }));`,
        [title],
      );
      await app.exec(`document.querySelector('form[aria-label="Nowe zadanie"] button[type=submit]').click()`);
      await app.waitFor(`return !!document.querySelector('li[aria-label="#1 ${title}"]')`, 20_000);

      // Conversation mode: the first message names the file, the file goes as a resource link.
      await openRunForm();
      await app.exec(
        `const s = document.querySelector('select[aria-label="Agent"]');
         Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'claude');
         s.dispatchEvent(new Event('change', { bubbles: true }));`,
      );
      await app.click('[role=group][aria-label="Uruchom agenta: zadanie #1"] button', "Uruchom");
      await app.waitFor(
        `return [...document.querySelectorAll('${chat} [role=log]')].some(l => l.textContent.includes('Echo: Wykonaj zadanie opisane w pliku .leverframe/tasks/1-agent-na-zadaniu.md (${title})'))`,
        30_000,
      );
      const log = await app.exec(`return [...document.querySelectorAll('${chat} [role=log]')].map(l => l.textContent).join(' ')`);
      assert.ok(log.includes(`[plik: file://${encodeURI(file)}]`), log);
      // The turn ended: „Do sprawdzenia”, the run in the header, the count on the activity bar.
      await waitFile(/\nstatus: review\n/);
      assert.match(readFileSync(file, "utf8"), /\nruns:\n  - \{at: "[^"]+", agent: "claude", profile: "local:bash", mode: "chat", cwd: "[^"]+"\}\n/);
      await app.waitFor(`return document.querySelector('nav button[aria-label="Zadania"]').textContent.trim() === '1'`, 20_000);
      await app.waitFor(`return !!document.querySelector('ul[aria-label="Zadania: Do sprawdzenia"] li[aria-label="#1 ${title}"]')`, 20_000);
      await app.exec(`document.querySelector('button[aria-label="Uruchomienia: ${title}"]').click()`);
      await app.waitFor(`return document.querySelector('[role=group][aria-label="Uruchomienia zadania #1"]')?.textContent.includes('Claude Code · bash · rozmowa')`);

      // Terminal: the agent starts with the message as its argument; the task is „W toku” again.
      const args = join(env.home, "claude-args.txt");
      rmSync(args, { force: true });
      await openRunForm();
      await app.click('[role=group][aria-label="Uruchom agenta: zadanie #1"] label', "Terminal");
      await app.click('[role=group][aria-label="Uruchom agenta: zadanie #1"] button', "Uruchom");
      for (let i = 0; i < 150 && !existsSync(args); i++) await sleep(100);
      assert.match(readFileSync(args, "utf8"), /^Wykonaj zadanie opisane w pliku \.leverframe\/tasks\/1-agent-na-zadaniu\.md \(Agent na zadaniu\)\. Na końcu/);
      await waitFile(/\nstatus: doing\n[\s\S]*mode: "terminal"/);
      assert.equal(readFileSync(join(env.home, "claude-ran.txt"), "utf8").trim(), env.project);
    } finally {
      rmSync(join(env.project, ".leverframe"), { recursive: true, force: true });
      rmSync(join(env.home, "claude-args.txt"), { force: true });
    }
  });
  it("keeps tasks in an own project folder and an own global folder; moves them back (#114)", async () => {
    const own = join(env.project, "docs", "zadania");
    const globalDir = join(env.home, "zadania-globalne");
    const setting = (key, value) =>
      app.exec(`return window.__TAURI_INTERNALS__.invoke('settings_update', { key: arguments[0], value: arguments[1] }).then(() => true)`, [key, value]);
    const create = async (title) => {
      await app.waitFor("return !!document.querySelector('button[aria-label=\"Nowe zadanie…\"]:not([disabled])')", 20_000);
      await app.exec(`document.querySelector('button[aria-label="Nowe zadanie…"]').click()`);
      await app.waitFor("return !!document.querySelector('form[aria-label=\"Nowe zadanie\"] input')");
      await app.exec(
        `const i = document.querySelector('form[aria-label="Nowe zadanie"] input');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[0]);
         i.dispatchEvent(new Event('input', { bubbles: true }));`,
        [title],
      );
      await app.exec(`document.querySelector('form[aria-label="Nowe zadanie"] button[type=submit]').click()`);
      await app.waitFor(`return !!document.querySelector('li[aria-label$=" ${title}"]')`, 20_000);
    };
    const projectField = async (value) => {
      await app.waitFor("return !!document.querySelector('input[aria-label=\"Folder zadań w projekcie\"]')", 20_000);
      await app.exec(
        `const i = document.querySelector('input[aria-label="Folder zadań w projekcie"]');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[0]);
         i.dispatchEvent(new Event('input', { bubbles: true }));
         i.focus(); i.blur();`,
        [value],
      );
    };
    try {
      // The project's folder, typed in the settings.
      await showView("Ustawienia");
      await projectField("docs/zadania");
      await app.waitFor(`return document.querySelector('input[aria-label="Folder zadań w projekcie"]').value === 'docs/zadania'`);
      await waitForSetting("tasksProjectDir", "docs/zadania");
      await showView("Zadania");
      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await create("W nowym folderze");
      assert.ok(existsSync(join(own, "1-w-nowym-folderze.md")), "in the own folder");

      // The global folder anywhere.
      await setting("tasksGlobalDir", globalDir);
      await app.click('[aria-label="Lista zadań"] button', "Globalne");
      await app.exec(`document.querySelector('aside[aria-label="Zadania"] button[aria-label="Odśwież"]').click()`);
      await create("Globalne gdzie indziej");
      assert.ok(existsSync(join(globalDir, "1-globalne-gdzie-indziej.md")), "in the own global folder");

      // Back to the default folder: the task there moves along.
      await showView("Ustawienia");
      await projectField("");
      await app.waitFor("return !!document.querySelector('[role=group][aria-label=\"Przenieść zadania?\"]')", 20_000);
      await app.click('[role=group][aria-label="Przenieść zadania?"] button', "Przenieś");
      await app.waitFor("return document.body.innerText.includes('Przeniesiono zadania: 1.')", 20_000);
      assert.ok(existsSync(join(env.project, ".leverframe", "tasks", "1-w-nowym-folderze.md")), "moved back");
      assert.equal(existsSync(join(own, "1-w-nowym-folderze.md")), false);
    } finally {
      await setting("tasksGlobalDir", "").catch(() => undefined);
      await setting("tasksProjectDir", "").catch(() => undefined);
      rmSync(join(env.project, "docs"), { recursive: true, force: true });
      rmSync(join(env.project, ".leverframe"), { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

/** Waits until settings.json has the value (the app saved it). */
async function waitForSetting(key, value, timeout = 10_000) {
  const file = join(env.config, "settings.json");
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    if (JSON.parse(readFileSync(file, "utf8"))[key] === value) return;
  }
  assert.fail(`settings.json: ${key} is not ${JSON.stringify(value)}`);
}
