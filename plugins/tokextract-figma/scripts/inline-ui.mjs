// Inlines dist/ui.js into src/ui.html and writes dist/ui.html.
// Figma plugins must ship a single HTML file with no external scripts.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const html = readFileSync(resolve(root, "src/ui.html"), "utf8");
const js = readFileSync(resolve(root, "dist/ui.js"), "utf8");

const inlined = html.replace(
  /<script\s+src="ui\.js"><\/script>/,
  `<script>${js}</script>`,
);

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/ui.html"), inlined);

console.log("Wrote dist/ui.html");
