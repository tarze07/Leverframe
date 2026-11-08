// Minimal WebDriver client for tauri-driver (https://v2.tauri.app/develop/tests/webdriver/).
// Playwright cannot drive the Linux WebKitGTK webview, so the end-to-end tests talk WebDriver directly.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${method} ${path}: ${json.value.error}: ${json.value.message}`);
  return json.value;
}

/** Starts tauri-driver with the given environment (e.g. an isolated HOME) and waits until it answers. */
export async function startDriver(env) {
  const proc = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", ["--port", String(PORT)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/status`);
      return proc;
    } catch {
      await sleep(100);
    }
  }
  proc.kill();
  throw new Error("tauri-driver did not start");
}

export class App {
  static async launch(application) {
    const s = await req("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const app = new App(s.sessionId);
    await app.waitFor("return !!document.querySelector('nav[aria-label=\"Activity bar\"]')", 30_000);
    return app;
  }

  constructor(id) {
    this.id = id;
  }

  path(p) {
    return `/session/${this.id}${p}`;
  }

  exec(script, args = []) {
    return req("POST", this.path("/execute/sync"), { script, args });
  }

  /** Polls a script until it returns a truthy value. */
  async waitFor(script, timeout = 10_000, args = []) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.exec(script, args);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await sleep(150);
    }
    throw new Error(`Timeout waiting for: ${script} (last: ${last})`);
  }

  /** Clicks the first element matching a CSS selector whose text or aria-label contains `text`. */
  click(selector, text = "") {
    return this.exec(
      `const el = [...document.querySelectorAll(arguments[0])].find(e => !arguments[1] || (e.innerText || '').includes(arguments[1]) || (e.getAttribute('aria-label') || '').includes(arguments[1]) || (e.title || '').includes(arguments[1]));
       if (!el) throw new Error('not found: ' + arguments[0] + ' ' + arguments[1]);
       el.click(); return true;`,
      [selector, text],
    );
  }

  keys(actions) {
    return req("POST", this.path("/actions"), { actions: [{ type: "key", id: "kb", actions }] });
  }

  type(text) {
    return this.keys([...text].flatMap((c) => [{ type: "keyDown", value: c }, { type: "keyUp", value: c }]));
  }

  chord(...keys) {
    return this.keys([...keys.map((value) => ({ type: "keyDown", value })), ...[...keys].reverse().map((value) => ({ type: "keyUp", value }))]);
  }

  async screenshot() {
    return Buffer.from(await req("GET", this.path("/screenshot")), "base64");
  }

  async close() {
    await req("DELETE", this.path("/window")).catch(() => {});
    await req("DELETE", this.path("")).catch(() => {});
  }
}

export const KEY = { ctrl: "", shift: "", alt: "", enter: "", end: "", escape: "" };
