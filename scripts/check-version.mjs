#!/usr/bin/env node
// Checks that package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json carry the same version,
// and (optionally) that it matches a release tag: `node scripts/check-version.mjs v0.1.0-alpha.1`.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const versions = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
};

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Wersje się różnią:", versions);
  process.exit(1);
}
const [version] = unique;

const tag = process.argv[2];
if (tag && tag.replace(/^refs\/tags\//, "").replace(/^v/, "") !== version) {
  console.error(`Tag ${tag} nie pasuje do wersji ${version}`);
  process.exit(1);
}
console.log(`Wersja: ${version}`);
