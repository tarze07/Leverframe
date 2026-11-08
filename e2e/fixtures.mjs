// Builds an isolated HOME for the app: fake agent CLIs, a project, sample agent logs, settings.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures = new URL("../src-tauri/src/sessions/logs/fixtures/", import.meta.url);

export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "lf-e2e-"));
  const bin = join(home, "bin");
  const project = join(home, "projects", "shop");
  const config = join(home, ".config", "io.github.tarze07.leverframe");
  for (const d of [bin, join(project, "src"), join(project, "node_modules", "x"), config]) mkdirSync(d, { recursive: true });

  // Fake agent: prints its version, or records that it ran (and where) and prints a marker.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (e2e)"; exit 0; fi\npwd > "$HOME/claude-ran.txt"\nprintf 'E2E-AGENT-OUTPUT refactor done\\n'\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  // PATH only via .bashrc – like nvm – to check that detection uses the login shell's PATH.
  writeFileSync(join(home, ".bashrc"), 'export PATH="$HOME/bin:$PATH"\n');
  writeFileSync(join(home, ".profile"), "[ -f ~/.bashrc ] && . ~/.bashrc\n");

  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "src", "payments.ts"), "export const total = 1;\n");
  writeFileSync(join(project, "node_modules", "x", "index.js"), "ignored\n");

  const claudeLogs = join(home, ".claude", "projects", "-home-me-shop");
  mkdirSync(claudeLogs, { recursive: true });
  cpSync(new URL("claude.jsonl", fixtures), join(claudeLogs, "5f1c2a9e-1111-4c3b-9d7e-0123456789ab.jsonl"));
  const codexLogs = join(home, ".codex", "sessions", "2026", "11", "04");
  mkdirSync(codexLogs, { recursive: true });
  cpSync(new URL("codex.jsonl", fixtures), join(codexLogs, "rollout-2026-11-04T08-00-00-0199a1b2.jsonl"));

  writeFileSync(join(config, "settings.json"), JSON.stringify({ projectDir: project, defaultProfile: "local:bash" }, null, 2));
  return { home, project, config };
}
