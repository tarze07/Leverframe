// End-to-end tests of Docker containers on the real application window (Linux) with a real
// Docker: `npm run e2e:docker` after `npm run tauri build -- --debug --no-bundle` and
// `cargo build --example fake_acp_agent`, inside an X server (e.g. `xvfb-run`).
//
// A small test image (busybox + the scripted ACP agent as Claude's adapter + a fake `claude`)
// is built from the "Kontenery" view; a container of it with the project folder runs the
// terminal, the agent in a terminal, a conversation that changes a file through the editor,
// and the conversation is resumed from the history. Without Docker the tests are skipped,
// unless E2E_DOCKER_REQUIRED=1 (CI).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { App, KEY, startDriver } from "./driver.mjs";
import { makeHome } from "./fixtures.mjs";

const APP = process.env.LEVERFRAME_APP ?? new URL("../src-tauri/target/debug/leverframe", import.meta.url).pathname;
const FAKE_ACP = process.env.LEVERFRAME_FAKE_ACP ?? new URL("../src-tauri/target/debug/examples/fake_acp_agent", import.meta.url).pathname;
const IMAGE = "lf-e2e-agents:1";
const CONTAINER = "shop-agenci";
const VOLUME = `leverframe-${CONTAINER}-home`;
const BASE = "busybox:1.36";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = (...args) => {
  try {
    docker(...args);
  } catch {
    // Not there.
  }
};

function dockerRuns() {
  try {
    return docker("info", "--format", "{{.OSType}}") === "linux";
  } catch {
    return false;
  }
}
const available = dockerRuns();
if (!available && process.env.E2E_DOCKER_REQUIRED === "1") throw new Error("Docker is required (E2E_DOCKER_REQUIRED=1) but does not run");

/** The build folder of the test image: the agent needs libgcc_s besides busybox's glibc. */
function imageFolder(home) {
  const dir = join(home, "obraz");
  mkdirSync(dir, { recursive: true });
  copyFileSync(FAKE_ACP, join(dir, "fake-acp-agent"));
  const libgcc = execFileSync("ldd", [FAKE_ACP], { encoding: "utf8" }).match(/libgcc_s\.so\.1 => (\S+)/)?.[1];
  if (libgcc) copyFileSync(libgcc, join(dir, "libgcc_s.so.1"));
  else writeFileSync(join(dir, "libgcc_s.so.1"), "");
  writeFileSync(join(dir, "claude-agent-acp"), '#!/bin/sh\nexec /usr/local/bin/fake-acp-agent --load "$@"\n');
  writeFileSync(join(dir, "claude"), '#!/bin/sh\nif [ "$1" = --version ]; then echo "7.7.7 (kontener)"; exit 0; fi\npwd > /workspace/claude-ran.txt\n');
  for (const f of ["fake-acp-agent", "claude-agent-acp", "claude"]) chmodSync(join(dir, f), 0o755);
  writeFileSync(
    join(dir, "Dockerfile"),
    [
      `FROM ${BASE}`,
      "COPY libgcc_s.so.1 /lib/",
      "COPY fake-acp-agent claude-agent-acp claude /usr/local/bin/",
      'LABEL io.leverframe.agents="1"',
      "WORKDIR /workspace",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("Leverframe with Docker", { skip: !available && "Docker is not available" }, () => {
  const env = available ? makeHome() : null;
  let driver;
  let app;
  const chat = "[data-testid=agent-chat]";
  const showView = (label) => app.click("nav button", label);
  const row = (name) => `li[aria-label="Kontener ${name}"]`;
  const has = (text) => `return document.querySelector('${chat} [role=log]')?.textContent.includes(${JSON.stringify(text)})`;
  const ready = () => app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 60_000);
  const say = async (text) => {
    await ready();
    await app.waitFor(`const t = document.querySelector('${chat} textarea[aria-label="Wiadomość do agenta"]'); t.focus(); return document.activeElement === t`);
    await app.type(`${text}${KEY.enter}`);
  };
  /** Clicks the button whose text is exactly `text` (icon buttons carry words in their labels). */
  const press = (scope, text) =>
    app.exec(
      `const b = [...document.querySelectorAll(arguments[0] + ' button')].find(b => b.textContent.trim() === arguments[1]);
       if (!b) throw new Error('no button ' + arguments[1]); b.click(); return true;`,
      [scope, text],
    );
  const waitForFile = async (file, timeout = 20_000) => {
    for (let i = 0; i < timeout / 100 && !(existsSync(file) && readFileSync(file, "utf8").trim()); i++) await sleep(100);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };

  before(async () => {
    quiet("rm", "-f", CONTAINER);
    quiet("volume", "rm", VOLUME);
    quiet("rmi", IMAGE);
    try {
      docker("image", "inspect", BASE);
    } catch {
      docker("pull", BASE);
    }
    driver = await startDriver({ HOME: env.home, SHELL: "/bin/bash", XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" });
    app = await App.launch(APP);
  });

  after(async () => {
    if (process.env.E2E_SCREENSHOT && app) writeFileSync(process.env.E2E_SCREENSHOT, await app.screenshot());
    await app?.close();
    driver?.kill();
    quiet("rm", "-f", CONTAINER);
    quiet("volume", "rm", VOLUME);
    quiet("rmi", IMAGE);
    try {
      rmSync(env.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`Could not remove ${env.home}: ${e.message}`);
    }
  });

  it("builds an image from a folder with a Dockerfile, with its output", async () => {
    const dir = imageFolder(env.home);
    await showView("Kontenery");
    await app.waitFor("return !!document.querySelector('ul[aria-label=Obrazy]')", 20_000);
    await app.click("section button", "Zbuduj…");
    const form = 'form[aria-label="Zbuduj obraz"]';
    // The folder typed in (the dialog of "Wybierz…" is native).
    const fill = (selector, value) =>
      app.exec(
        `const i = document.querySelector(arguments[0]); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, arguments[1]); i.dispatchEvent(new Event('input', { bubbles: true }));`,
        [selector, value],
      );
    await fill(`${form} input[aria-label="Folder z plikiem Dockerfile"]`, dir);
    await fill(`${form} input[placeholder^="nazwa obrazu"]`, IMAGE);
    await app.click(`${form} button[type=submit]`);
    const job = `li[aria-label="Budowanie ${IMAGE}"]`;
    await app.waitFor(`return document.querySelector('${job}')?.innerText.includes('Gotowe.')`, 120_000);
    await app.click(`${job} summary`);
    assert.match(await app.exec(`return document.querySelector('${job}').innerText`), /COPY fake-acp-agent/);
    await app.waitFor(`return !!document.querySelector('li[aria-label="Obraz ${IMAGE}"]')`, 20_000);
  });

  it("creates a container with the project folder, stops and starts it", async () => {
    await app.click(`li[aria-label="Obraz ${IMAGE}"] button`, "Nowy kontener");
    const form = 'form[aria-label="Nowy kontener"]';
    await app.waitFor(`return document.querySelector('${form} [aria-label=Polecenie]')?.innerText.includes('docker run')`, 20_000);
    const command = await app.exec(`return document.querySelector('${form} [aria-label=Polecenie]').innerText`);
    assert.ok(command.includes(`${env.project}:/workspace`), command);
    assert.ok(command.includes(`${VOLUME}:/home/agent`), command);
    // Warnings (none expected for this image) would have to be accepted.
    if (await app.exec(`return [...document.querySelectorAll('${form} label')].some(l => l.textContent.includes('Rozumiem'))`)) {
      await app.exec(`[...document.querySelectorAll('${form} label')].find(l => l.textContent.includes('Rozumiem')).querySelector('input').click()`);
    }
    await app.click(`${form} button[type=submit]`);
    await app.waitFor(`return document.querySelector('${row(CONTAINER)}')?.innerText.includes('działa')`, 60_000);
    assert.equal(docker("inspect", "-f", "{{ index .Config.Labels \"io.leverframe.agents\" }}", CONTAINER), "1");

    await app.click(`${row(CONTAINER)} button[aria-label="Zatrzymaj ${CONTAINER}"]`);
    await app.waitFor(`return document.querySelector('${row(CONTAINER)}')?.innerText.includes('zatrzymany')`, 60_000);
    await app.click(`${row(CONTAINER)} button[aria-label="Uruchom ${CONTAINER}"]`);
    await app.waitFor(`return document.querySelector('${row(CONTAINER)}')?.innerText.includes('działa')`, 60_000);
  });

  it("opens a terminal in the container, in the project folder", async () => {
    const before = await app.exec("return document.querySelectorAll('.xterm').length");
    await app.click(`${row(CONTAINER)} button[aria-label="Terminal w ${CONTAINER}"]`);
    await app.waitFor(`return document.querySelectorAll('.xterm').length > ${before}`, 20_000);
    await app.waitFor("const t = [...document.querySelectorAll('.xterm-helper-textarea')].pop(); t.focus(); return document.activeElement === t");
    // Retried: the shell in the container may not be up yet.
    const file = join(env.project, "terminal.txt");
    for (let i = 0; i < 5 && !existsSync(file); i++) {
      await app.type(`[ -f /.dockerenv ] && pwd > /workspace/terminal.txt${KEY.enter}`);
      await waitForFile(file, 4_000);
    }
    assert.equal(await waitForFile(file), "/workspace");
  });

  it("detects the agent in the container and starts it in the container's terminal", async () => {
    await showView("Agenci");
    await app.waitFor(`return !!document.querySelector('select option[value="container:${CONTAINER}"]')`, 30_000);
    await app.exec(
      `const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'container:${CONTAINER}'); s.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
    await app.waitFor("return document.querySelector('li[aria-label=\"Claude Code\"]')?.innerText.includes('7.7.7 (kontener)')", 60_000);
    await app.click('li[aria-label="Claude Code"] button', "Terminal");
    assert.equal(await waitForFile(join(env.project, "claude-ran.txt"), 30_000), "/workspace");
  });

  it("talks to the agent in the container; it changes a file through the editor", async () => {
    // Unsaved text in an open editor.
    const readmeBar = `[...document.querySelectorAll('[aria-label="Pasek edytora"]')].find(b => b.querySelector('span[title$="README.md"]'))`;
    await showView("Pliki");
    await app.waitFor("return !!document.querySelector('[role=treeitem][aria-label=\"README.md\"]')", 20_000);
    await app.click('[role=treeitem][aria-label="README.md"] button');
    await app.waitFor(`const b = ${readmeBar}; return !!b && !!b.parentElement.querySelector('.view-line')`, 20_000);
    await app.waitFor(`const ta = ${readmeBar}.parentElement.querySelector('textarea.inputarea'); ta.focus(); return document.activeElement === ta`);
    await app.chord(KEY.ctrl, KEY.end);
    await app.type("\nNiezapisane w kontenerze.");
    await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('● README.md'))");

    await showView("Agenci");
    await app.click('li[aria-label="Claude Code"] button', "Rozmowa");
    await ready();
    assert.match(await app.exec(`return document.querySelector('${chat} header').textContent`), new RegExp(`fake-acp-agent.*${CONTAINER} · /workspace`));
    await say("pwd");
    await app.waitFor(has("cwd=/workspace"), 20_000);

    await say("edit");
    const card = `${chat} [role=group][aria-label="Prośba o zgodę"]`;
    await app.waitFor(`return document.querySelector('${card}')?.textContent.includes('+ Dopisane przez agenta.')`, 20_000);
    assert.match(await app.exec(`return document.querySelector('${card}').textContent`), /Niezapisane w kontenerze\./, "the agent got the unsaved text");
    await app.click(`${card} button`, "Zezwól");
    await app.waitFor(has("zapisano"), 20_000);
    assert.match(readFileSync(join(env.project, "README.md"), "utf8"), /Niezapisane w kontenerze\.\nDopisane przez agenta\.\n$/);

    // Its command runs in the container.
    await say("run");
    await app.waitFor(`return [...document.querySelectorAll('${chat} button')].some(b => b.textContent.trim() === 'Uruchom')`, 20_000);
    await app.click(`${chat} button`, "Uruchom");
    await app.waitFor(has("wynik: kod 3"), 30_000);
  });

  it("resumes the conversation in the container from the history", async () => {
    await showView("Rozmowy");
    const listed = 'ul[aria-label="Otwarte rozmowy"] li';
    await app.waitFor(`return !!document.querySelector('${listed}')`, 20_000);
    await app.click(`${listed} button[aria-label="Zakończ rozmowę"]`);
    await app.waitFor(`return !document.querySelector('${listed}')`, 20_000);

    await showView("Sesje");
    await app.click('[role="tab"]', "Historia");
    await app.exec(
      "const s = document.querySelector('select[aria-label=\"Rodzaj\"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'acp'); s.dispatchEvent(new Event('change', { bubbles: true }));",
    );
    const entry = 'li[aria-label^="Rozmowa Claude Code"]';
    await app.waitFor(`return !!document.querySelector('${entry}')`, 20_000);
    await app.click(`${entry} button`, "Claude Code");
    await app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Historia'`, 20_000);
    await app.click(`${chat} [aria-label="Rozmowa z historii"] button`, "Wznów rozmowę");
    await ready();
    assert.match(await app.exec(`return document.querySelector('${chat} header').textContent`), new RegExp(`${CONTAINER} · /workspace`));
    await say("dalej w kontenerze");
    await app.waitFor(has("Echo: dalej w kontenerze"), 20_000);
  });

  it("removes the container and its volume", async () => {
    await showView("Kontenery");
    await app.click(`${row(CONTAINER)} button[aria-label="Usuń kontener ${CONTAINER}"]`);
    await press(row(CONTAINER), "Usuń");
    await app.waitFor(`return !document.querySelector('${row(CONTAINER)}')`, 60_000);
    const volume = `li[aria-label="Wolumen ${VOLUME}"]`;
    await app.waitFor(`return !!document.querySelector('${volume}')`, 20_000);
    await app.click(`${volume} button[aria-label="Usuń wolumen ${VOLUME}"]`);
    await press(volume, "Usuń");
    await app.waitFor(`return !document.querySelector('${volume}')`, 30_000);
    assert.equal(docker("ps", "-a", "-q", "--filter", `name=^${CONTAINER}$`), "");
  });
});
