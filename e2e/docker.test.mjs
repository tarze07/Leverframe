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

/** Tasks in the "Zadania" view (#108): a new one, an agent started on it. */
function taskSteps(app) {
  const form = (id) => `[role=group][aria-label="Uruchom agenta: zadanie #${id}"]`;
  return {
    async create(title) {
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
    },
    async run(id, title, profileId) {
      await app.exec(`document.querySelector('button[aria-label="Uruchom agenta: ${title}"]').click()`);
      await app.waitFor(`return !!document.querySelector('${form(id)} select[aria-label="Profil"] option[value="${profileId}"]')`, 20_000);
      await app.exec(
        `for (const [label, value] of [["Agent", "claude"], ["Profil", arguments[1]]]) {
           const s = document.querySelector(arguments[0] + ' select[aria-label="' + label + '"]');
           Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, value);
           s.dispatchEvent(new Event('change', { bubbles: true }));
         }
         [...document.querySelectorAll(arguments[0] + ' button')].find(b => b.textContent.trim() === 'Uruchom').click();`,
        [form(id), profileId],
      );
      await app.waitFor(`return !document.querySelector('${form(id)}')`, 60_000);
    },
    /** Some conversation's transcript contains the text. */
    logHas: (text) => `return [...document.querySelectorAll('[data-testid=agent-chat] [role=log]')].some(l => l.textContent.includes(${JSON.stringify(text)}))`,
  };
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

  it("starts an agent on tasks in the container: the mounted file, a copy of a global task and its result (#108)", async () => {
    const steps = taskSteps(app);
    const profileId = `container:${CONTAINER}`;
    const globalDir = join(env.home, ".local", "share", "io.github.tarze07.leverframe", "tasks");
    try {
      await showView("Zadania");
      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await steps.create("Zadanie w kontenerze");
      await steps.run(1, "Zadanie w kontenerze", profileId);
      // The container sees the project folder: the file itself, by its path there.
      await app.waitFor(steps.logHas("Echo: Wykonaj zadanie opisane w pliku .leverframe/tasks/1-zadanie-w-kontenerze.md"), 60_000);
      await app.waitFor(steps.logHas("[plik: file:///workspace/.leverframe/tasks/1-zadanie-w-kontenerze.md]"));

      // A global task is not in the container: it is copied to its folder.
      await app.click('[aria-label="Lista zadań"] button', "Globalne");
      await steps.create("Globalne w kontenerze");
      await steps.run(1, "Globalne w kontenerze", profileId);
      await app.waitFor(steps.logHas("[plik: file:///workspace/.leverframe/tasks/1-globalne-w-kontenerze.md]"), 60_000);
      const copy = join(env.project, ".leverframe", "tasks", "1-globalne-w-kontenerze.md");
      assert.match(readFileSync(copy, "utf8"), /title: "Globalne w kontenerze"/);
      // The agent's result in the copy comes back after the changes are shown.
      writeFileSync(copy, `${readFileSync(copy, "utf8")}\n## Wynik\nGotowe w kontenerze.\n`);
      await app.exec(`document.querySelector('button[aria-label="Uruchomienia: Globalne w kontenerze"]').click()`);
      await app.waitFor("return [...document.querySelectorAll('[role=group][aria-label=\"Uruchomienia zadania #1\"] button')].some(b => b.textContent.trim() === 'Pobierz wynik')");
      await press('[role=group][aria-label="Uruchomienia zadania #1"]', "Pobierz wynik");
      await app.waitFor("return !!document.querySelector('[role=group][aria-label=\"Wynik z komputera agenta\"]')", 30_000);
      await app.waitFor("return [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('Zmiana: 1-globalne-w-kontenerze.md'))");
      await press('[role=group][aria-label="Wynik z komputera agenta"]', "Zapisz w zadaniu");
      for (let i = 0; i < 100 && !readFileSync(join(globalDir, "1-globalne-w-kontenerze.md"), "utf8").includes("Gotowe w kontenerze."); i++) await sleep(100);
      assert.match(readFileSync(join(globalDir, "1-globalne-w-kontenerze.md"), "utf8"), /## Wynik\nGotowe w kontenerze\.\n$/);
    } finally {
      rmSync(join(env.project, ".leverframe"), { recursive: true, force: true });
    }
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

// Docker on an SSH host (D8): E2E_DOCKER_SSH=user@host[:port] – a host whose sshd accepts this
// machine's key without questions (BatchMode) and runs Docker (in CI: sshd on the runner itself).
// Its folders are the "server's": on the same machine the project folder is the same path.
const sshTarget = /^([^@\s]+)@([^:\s]+)(?::(\d+))?$/.exec(process.env.E2E_DOCKER_SSH ?? "");
if (!sshTarget && process.env.E2E_DOCKER_SSH_REQUIRED === "1") throw new Error("E2E_DOCKER_SSH=user@host[:port] is required");

// Twice: with the docker CLI of this machine (DOCKER_HOST=ssh://…) and without it (D9, #89: a
// docker program that does not exist, so `auto` runs `ssh host docker …`).
for (const noClient of [false, true])
describe(`Leverframe with Docker on an SSH host${noClient ? " without a local docker client" : ""}`, { skip: (!available || !sshTarget) && "Docker over SSH is not configured (E2E_DOCKER_SSH)" }, () => {
  const env = available && sshTarget ? makeHome() : null;
  const SSH_IMAGE = "lf-e2e-agents:ssh";
  const NAME = noClient ? "shop-sshonly" : "shop-ssh";
  // A container that writes to its log (Leverframe's ones only sleep).
  const TALKER = `${NAME}-logi`;
  const BUILD = "docker build --progress=plain -t leverframe-agents";
  const SSH_VOLUME = `leverframe-${NAME}-home`;
  // Without a local client the host is a `~/.ssh/config` entry (connected by its alias), with
  // it a user profile: both kinds of SSH profiles are Docker sources.
  const sshHost = sshTarget?.[2];
  const HOST_ID = noClient ? `ssh-config:${sshHost}` : "user-dockerhost";
  const HOST_NAME = noClient ? sshHost : "lf-docker";
  let driver;
  let app;
  const chat = "[data-testid=agent-chat]";
  const showView = (label) => app.click("nav button", label);
  const row = `li[aria-label="Kontener ${NAME}"]`;
  const has = (text) => `return document.querySelector('${chat} [role=log]')?.textContent.includes(${JSON.stringify(text)})`;
  const ready = () => app.waitFor(`return document.querySelector('${chat} [role=status]')?.textContent === 'Gotowy'`, 60_000);
  const say = async (text) => {
    await ready();
    await app.waitFor(`const t = document.querySelector('${chat} textarea[aria-label="Wiadomość do agenta"]'); t.focus(); return document.activeElement === t`);
    await app.type(`${text}${KEY.enter}`);
  };
  const fill = (selector, value, proto = "HTMLInputElement") =>
    app.exec(
      `const i = document.querySelector(arguments[0]); Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(i, arguments[1]); i.dispatchEvent(new Event(arguments[2], { bubbles: true }));`,
      [selector, value, proto === "HTMLSelectElement" ? "change" : "input"],
    );
  const press = (scope, text) =>
    app.exec(
      `const b = [...document.querySelectorAll(arguments[0] + ' button')].find(b => b.textContent.trim() === arguments[1]);
       if (!b) throw new Error('no button ' + arguments[1]); b.click(); return true;`,
      [scope, text],
    );
  const waitForFile = async (file, timeout = 30_000) => {
    for (let i = 0; i < timeout / 100 && !(existsSync(file) && readFileSync(file, "utf8").trim()); i++) await sleep(100);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };

  before(async () => {
    quiet("rm", "-f", NAME);
    quiet("rm", "-f", TALKER);
    quiet("volume", "rm", SSH_VOLUME);
    try {
      docker("image", "inspect", BASE);
    } catch {
      docker("pull", BASE);
    }
    docker("build", "-q", "-t", SSH_IMAGE, imageFolder(env.home));
    // The SSH host as a user profile.
    const [, user, host, port] = sshTarget;
    if (noClient) {
      // Read by Leverframe from $HOME; ssh itself connects to the alias as this user.
      mkdirSync(join(env.home, ".ssh"), { recursive: true });
      writeFileSync(join(env.home, ".ssh", "config"), `Host ${host}\n  User ${user}\n${port ? `  Port ${port}\n` : ""}`);
    } else {
      writeFileSync(
        join(env.config, "profiles.json"),
        JSON.stringify({
          profiles: [{ id: HOST_ID, name: HOST_NAME, kind: "ssh", command: "ssh", args: [], ssh: { host, user, ...(port ? { port: Number(port) } : {}) } }],
        }),
      );
    }
    if (noClient) {
      const file = join(env.config, "settings.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), dockerPath: join(env.home, "brak", "docker") }, null, 2));
    }
    driver = await startDriver({ HOME: env.home, SHELL: "/bin/bash", XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" });
    app = await App.launch(APP);
  });

  after(async () => {
    if (process.env.E2E_SCREENSHOT_SSH && app) writeFileSync(process.env.E2E_SCREENSHOT_SSH, await app.screenshot());
    await app?.close();
    driver?.kill();
    quiet("rm", "-f", NAME);
    quiet("rm", "-f", TALKER);
    quiet("volume", "rm", SSH_VOLUME);
    quiet("rmi", SSH_IMAGE);
    if (noClient) {
      // A build of the agents image the test stopped must not go on.
      try {
        execFileSync("pkill", ["-f", BUILD]);
      } catch {
        // None.
      }
    }
    try {
      rmSync(env.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`Could not remove ${env.home}: ${e.message}`);
    }
  });

  it("shows the Docker of the SSH host and creates a container with a folder on the server", async () => {
    await showView("Kontenery");
    await app.waitFor(`return !!document.querySelector('select option[value="${HOST_ID}"]')`, 20_000);
    const select = [...(await app.exec("return [...document.querySelectorAll('label')].map(l => l.textContent)"))].includes("Docker na");
    assert.ok(select, "the source can be chosen");
    await app.exec(
      `const s = [...document.querySelectorAll('select')].find(s => s.querySelector('option[value="${HOST_ID}"]')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${HOST_ID}'); s.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
    if (noClient) {
      await app.waitFor("return document.body.textContent.includes('Automatycznie (ssh – brak klienta docker)')", 20_000);
      await app.waitFor("return document.body.textContent.includes('Polecenia docker są uruchamiane na serwerze przez ssh')", 20_000);
    } else {
      await app.waitFor("return [...document.querySelectorAll('code')].some(c => c.textContent.startsWith('ssh://'))", 20_000);
    }
    await app.waitFor(`return !!document.querySelector('li[aria-label="Obraz ${SSH_IMAGE}"]')`, 60_000);

    await app.click(`li[aria-label="Obraz ${SSH_IMAGE}"] button`, "Nowy kontener");
    const form = 'form[aria-label="Nowy kontener"]';
    await app.waitFor(`return !!document.querySelector('${form}')`);
    const label = await app.exec(`return [...document.querySelectorAll('${form} label')].find(l => l.textContent.startsWith('Folder projektu')).textContent`);
    assert.ok(label.startsWith(`Folder projektu na ${HOST_NAME}`), label);
    // The folder on the server, chosen by browsing it (#100): the picker lists the server's
    // folders over SSH, a typed path is opened, "Wybierz ten folder" fills the field.
    await press(form, "Wybierz…");
    const picker = `${form} [role=dialog][aria-label^="Wybierz folder na"]`;
    await app.waitFor(`return document.querySelector('${picker} input[aria-label="Ścieżka"]')?.value.startsWith('/')`, 30_000);
    await fill(`${picker} input[aria-label="Ścieżka"]`, join(env.project, ".."));
    await press(picker, "Przejdź");
    const projectName = env.project.split("/").pop();
    await app.waitFor(`return [...document.querySelectorAll('${picker} ul[aria-label=Foldery] button')].some(b => b.textContent.trim() === ${JSON.stringify(projectName)})`, 30_000);
    await press(`${picker} ul[aria-label=Foldery]`, projectName);
    await app.waitFor(`return document.querySelector('${picker} input[aria-label="Ścieżka"]').value === ${JSON.stringify(env.project)}`, 30_000);
    await press(picker, "Wybierz ten folder");
    await app.waitFor(`return document.querySelector('${form} input[placeholder^="np. /home"]').value === ${JSON.stringify(env.project)}`);
    await fill(`${form} input`, NAME);
    await app.waitFor(`return document.querySelector('${form} [aria-label=Polecenie]')?.innerText.includes(${JSON.stringify(`${env.project}:/workspace`)}) && document.querySelector('${form} [aria-label=Polecenie]').innerText.includes('--name ${NAME}')`, 20_000);
    await app.click(`${form} button[type=submit]`);
    await app.waitFor(`return document.querySelector('${row}')?.innerText.includes('działa')`, 60_000);
  });

  it("builds the image with agents there from the Dockerfile sent through stdin (stopped)", { skip: !noClient && "only without a local client" }, async () => {
    // A folder of this machine cannot be the build context there.
    assert.equal(await app.exec("return [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Zbuduj…').disabled"), true);
    await app.click('button[aria-label="Zbuduj obraz Leverframe"]');
    const job = "ul[aria-label='Zadania Dockera'] li";
    await app.waitFor(`return document.querySelector("${job}")?.textContent.includes('load build definition from')`, 60_000);
    await press(job, "Przerwij");
    await app.waitFor(`return document.querySelector("${job} [role=status]")?.textContent === 'Przerwano'`, 20_000);
    await app.click(`${job} button[aria-label=Zamknij]`);
    // Stopping ssh ends the build on the server.
    let left = true;
    for (let i = 0; i < 60 && left; i++) {
      try {
        execFileSync("pgrep", ["-f", BUILD]);
        await sleep(500);
      } catch {
        left = false;
      }
    }
    assert.equal(left, false, "the build on the server ended");
  });

  it("follows a container's logs there; a container without output says so (#94)", async () => {
    docker("run", "-d", "--name", TALKER, BASE, "sh", "-c", "echo pierwsza linia; echo druga linia; sleep 600");
    await app.click('button[aria-label="Odśwież"]');
    const talker = `li[aria-label="Kontener ${TALKER}"]`;
    await app.waitFor(`return !!document.querySelector('${talker}')`, 30_000);
    await app.click(`${talker} button[aria-label="Logi ${TALKER}"]`);
    const panel = (name) => `[...document.querySelectorAll('[data-testid=container-logs]')].find(p => p.querySelector('header').textContent.includes('Logi: ${name}'))`;
    await app.waitFor(`return ${panel(TALKER)}?.querySelector('pre').textContent.includes('druga linia')`, 30_000);
    assert.match(await app.exec(`return ${panel(TALKER)}.querySelector('[role=status]').textContent`), /Na żywo/);

    // Leverframe's container only sleeps: no "loading" forever, but a clear "nothing yet".
    await app.click(`${row} button[aria-label="Logi ${NAME}"]`);
    await app.waitFor(`return ${panel(NAME)}?.querySelector('pre').textContent.includes('Brak wpisów')`, 30_000);
    quiet("rm", "-f", TALKER);
  });

  it("opens a terminal in the container on the SSH host", async () => {
    const before = await app.exec("return document.querySelectorAll('.xterm').length");
    await app.click(`${row} button[aria-label="Terminal w ${NAME}"]`);
    await app.waitFor(`return document.querySelectorAll('.xterm').length > ${before}`, 20_000);
    await app.waitFor("const t = [...document.querySelectorAll('.xterm-helper-textarea')].pop(); t.focus(); return document.activeElement === t");
    const file = join(env.project, "ssh-terminal.txt");
    for (let i = 0; i < 5 && !existsSync(file); i++) {
      await app.type(`[ -f /.dockerenv ] && pwd > /workspace/ssh-terminal.txt${KEY.enter}`);
      await waitForFile(file, 5_000);
    }
    assert.equal(await waitForFile(file), "/workspace");
  });

  it("detects the agent there and talks to it; the agent keeps its own files", async () => {
    const profileId = `container:${HOST_ID}:${NAME}`;
    await showView("Agenci");
    await app.waitFor(`return !!document.querySelector('select option[value="${profileId}"]')`, 30_000);
    await app.exec(
      `const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${profileId}'); s.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
    await app.waitFor("return document.querySelector('li[aria-label=\"Claude Code\"]')?.innerText.includes('7.7.7 (kontener)')", 60_000);
    await app.click('li[aria-label="Claude Code"] button', "Terminal");
    assert.equal(await waitForFile(join(env.project, "claude-ran.txt")), "/workspace");

    await app.click('li[aria-label="Claude Code"] button', "Rozmowa");
    await ready();
    assert.match(await app.exec(`return document.querySelector('${chat} header').textContent`), new RegExp(`${NAME} \\(${HOST_NAME}\\) · /workspace`));
    await say("pwd");
    await app.waitFor(has("cwd=/workspace"), 20_000);
    // Files of the SSH host are not this machine's: Leverframe does not offer file access.
    await say("edit");
    await app.waitFor(has("edit: klient nie udostępnia plików"), 20_000);
  });

  it("starts an agent on a task in the container there: a copy on the server, its result (#108)", async () => {
    const steps = taskSteps(app);
    const profileId = `container:${HOST_ID}:${NAME}`;
    try {
      await showView("Zadania");
      await app.click('[aria-label="Lista zadań"] button', "Projekt");
      await steps.create("Zadanie na serwerze");
      await steps.run(1, "Zadanie na serwerze", profileId);
      await app.waitFor(steps.logHas("Echo: Wykonaj zadanie opisane w pliku .leverframe/tasks/1-zadanie-na-serwerze.md"), 60_000);
      await app.waitFor(steps.logHas("[plik: file:///workspace/.leverframe/tasks/1-zadanie-na-serwerze.md]"));
      // The copy is on the server (here the same folder): fetched, nothing has changed.
      await app.exec(`document.querySelector('button[aria-label="Uruchomienia: Zadanie na serwerze"]').click()`);
      await app.waitFor("return [...document.querySelectorAll('[role=group][aria-label=\"Uruchomienia zadania #1\"] button')].some(b => b.textContent.trim() === 'Pobierz wynik')");
      await press('[role=group][aria-label="Uruchomienia zadania #1"]', "Pobierz wynik");
      await app.waitFor("return document.querySelector('[role=group][aria-label=\"Uruchomienia zadania #1\"] [role=status]')?.textContent.includes('nie różni się')", 30_000);
    } finally {
      rmSync(join(env.project, ".leverframe"), { recursive: true, force: true });
    }
  });

  it("removes the container and its volume there", async () => {
    await showView("Kontenery");
    await app.click(`${row} button[aria-label="Usuń kontener ${NAME}"]`);
    await press(row, "Usuń");
    await app.waitFor(`return !document.querySelector('${row}')`, 60_000);
    const volume = `li[aria-label="Wolumen ${SSH_VOLUME}"]`;
    await app.waitFor(`return !!document.querySelector('${volume}')`, 20_000);
    await app.click(`${volume} button[aria-label="Usuń wolumen ${SSH_VOLUME}"]`);
    await press(volume, "Usuń");
    await app.waitFor(`return !document.querySelector('${volume}')`, 30_000);
    assert.equal(docker("ps", "-a", "-q", "--filter", `name=^${NAME}$`), "");
  });
});
