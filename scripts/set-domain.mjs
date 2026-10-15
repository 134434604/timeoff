// Point the setup documents at the address the app will live on, so the
// owner never has to edit a URL by hand: the Slack manifest's two request
// URLs, the Google redirect URIs, and every app address in the guides.
//
//   node scripts/set-domain.mjs timeoff.example.com    rewrite, and print what changed
//   node scripts/set-domain.mjs --check                list the address(es) the docs use now
//
// What is rewritten, in the files below: every https://timeoff.<host>
// address, the same host written bare (for example in a DNS step), and the
// placeholders "timeoff.<company domain>" and "timeoff.<your company domain>".
// Nothing else in the files changes.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FILES = [
  "docs/slack-manifest.yml",
  "docs/OWNER-SETUP.md",
  "docs/prompts-for-the-owner.md",
  "docs/HANDOFF.md",
  "docs/SETUP.md",
  "docs/HOSTING-GOOGLE-CLOUD.md",
  "docs/MOVE-TO-GOOGLE-CLOUD.md",
];
const ADDRESS = /https:\/\/(timeoff\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const PLACEHOLDERS = [/timeoff\.<company domain>/g, /timeoff\.<your company domain>/g];
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The timeoff.* hosts a text uses in https addresses. */
export function hostsIn(text) {
  return [...new Set([...String(text).matchAll(ADDRESS)].map((match) => match[1].toLowerCase()))];
}

/** The text with every current host and placeholder set to `host`; and how many places changed. */
export function rewrite(text, host) {
  let changed = 0;
  let out = String(text);
  for (const current of hostsIn(out)) {
    if (current === host) continue;
    // The host bare or inside a URL, but not as part of a longer name.
    const pattern = new RegExp(`(?<![a-z0-9.-])${escapeRegExp(current)}(?![a-z0-9-]|\\.[a-z0-9])`, "gi");
    out = out.replace(pattern, () => {
      changed += 1;
      return host;
    });
  }
  for (const placeholder of PLACEHOLDERS) {
    out = out.replace(placeholder, () => {
      changed += 1;
      return host;
    });
  }
  return { text: out, changed };
}

function main(argv) {
  const check = argv.includes("--check");
  const host = argv.find((arg) => !arg.startsWith("--"));
  if (!check && (!host || !HOST.test(host))) {
    console.log("Usage: node scripts/set-domain.mjs <app host, like timeoff.example.com>   or   --check");
    return 2;
  }
  for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) {
      console.log(`${rel}: not there, skipped`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (check) {
      const hosts = hostsIn(text);
      const placeholders = PLACEHOLDERS.reduce((sum, placeholder) => sum + (text.match(placeholder) || []).length, 0);
      console.log(`${rel}: ${hosts.length ? hosts.join(", ") : "no app address"}${placeholders ? `; ${placeholders} placeholder(s)` : ""}`);
      continue;
    }
    const result = rewrite(text, host.toLowerCase());
    if (result.changed) writeFileSync(file, result.text);
    console.log(`${rel}: ${result.changed ? `${result.changed} place(s) now say ${host.toLowerCase()}` : "nothing to change"}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
