#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version: `node scripts/release-notes.mjs 0.1.0-alpha.1`.
import { readFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (!version || start < 0) {
  console.error(`Brak sekcji ${version} w CHANGELOG.md`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith("## [") || /^\[[^\]]+\]:\s/.test(l));
console.log(rest.slice(0, end < 0 ? undefined : end).join("\n").trim());
