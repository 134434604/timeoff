// Ship a release to any host reachable by ssh, with the one rule that
// matters enforced structurally: production `data/` and `uploads/` are
// never inside the archive, so an extract cannot overwrite them. Host
// configuration comes entirely from the environment; nothing site- or
// host-specific is baked in.
//
// Usage:
//   node scripts/deploy-release.mjs --dry-run    assemble, verify, print the plan
//   node scripts/deploy-release.mjs --confirm    upload, extract, restart (env required)
//
// Required env for --confirm (also read on --dry-run when present):
//   DEPLOY_HOST  DEPLOY_USER  DEPLOY_PORT  DEPLOY_APP_DIR
// Optional:
//   DEPLOY_RESTART_CMD  run in DEPLOY_APP_DIR on the host after extracting
//                       (e.g. "sudo systemctl restart timeoff"); unset, the
//                       script touches tmp/restart.txt, which hosts that run
//                       Node behind a web server commonly watch.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmed = args.has("--confirm");
if (dryRun === confirmed) {
  console.error("Pass exactly one of --dry-run or --confirm.");
  process.exit(1);
}

const HOST = process.env.DEPLOY_HOST || "";
const USER = process.env.DEPLOY_USER || "";
const PORT = process.env.DEPLOY_PORT || "";
const APP_DIR = process.env.DEPLOY_APP_DIR || "";
const RESTART_CMD = String(process.env.DEPLOY_RESTART_CMD || "").trim();
const PAYLOAD = ["dist", "server", "scripts", "package.json", "docs"];
const FORBIDDEN = ["data/", "uploads/", "server/reference/", ".env"];

const staging = await mkdtemp(path.join(tmpdir(), "timeoff-release-"));
for (const entry of PAYLOAD) {
  const source = path.join(process.cwd(), entry);
  await mkdir(path.dirname(path.join(staging, entry)), { recursive: true });
  // Protected paths are left out while staging; the check below then proves none slipped in.
  const banned = (candidate) => {
    const rel = path.relative(process.cwd(), candidate).split(path.sep).join("/");
    return FORBIDDEN.some((prefix) => rel === prefix.replace(/\/$/, "") || rel.startsWith(prefix));
  };
  await cp(source, path.join(staging, entry), { recursive: true, filter: (candidate) => !banned(candidate) });
}

async function listEntries(dir, prefix = "") {
  const entries = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${item.name}${item.isDirectory() ? "/" : ""}`;
    entries.push(rel);
    if (item.isDirectory()) entries.push(...await listEntries(path.join(dir, item.name), rel));
  }
  return entries;
}

const entries = await listEntries(staging);
const violations = entries.filter((entry) => FORBIDDEN.some((banned) => entry === banned || entry.startsWith(banned)));
if (violations.length) {
  console.error(`REFUSED: the release payload contains protected state paths:\n${violations.map((entry) => `- ${entry}`).join("\n")}`);
  await rm(staging, { recursive: true, force: true });
  process.exit(1);
}

console.log(`Release payload assembled: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, zero under ${FORBIDDEN.join(" or ")}.`);

if (dryRun) {
  console.log("Dry run only. Remote plan:");
  console.log(`  target: ${USER || "<DEPLOY_USER>"}@${HOST || "<DEPLOY_HOST>"}:${APP_DIR || "<DEPLOY_APP_DIR>"} (port ${PORT || "<DEPLOY_PORT>"})`);
  console.log("  steps: upload archive -> extract beside data/ and uploads/ -> restart app");
  console.log(`  restart: ${RESTART_CMD || "touch tmp/restart.txt (set DEPLOY_RESTART_CMD to run your host's own restart)"}`);
  console.log("No upload was performed. Go-live remains a separate explicit owner decision.");
  await rm(staging, { recursive: true, force: true });
  process.exit(0);
}

if (!HOST || !USER || !PORT || !APP_DIR) {
  console.error("REFUSED: --confirm requires DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT, and DEPLOY_APP_DIR in the environment.");
  await rm(staging, { recursive: true, force: true });
  process.exit(1);
}

const archive = path.join(tmpdir(), `timeoff-release-${Date.now()}.tar.gz`);
const tar = spawnSync("tar", ["-czf", archive, "-C", staging, "."], { stdio: "inherit" });
if (tar.status !== 0) { console.error("Archive creation failed."); process.exit(1); }
const upload = spawnSync("scp", ["-P", PORT, archive, `${USER}@${HOST}:${APP_DIR}/release.tar.gz`], { stdio: "inherit" });
if (upload.status !== 0) { console.error("Upload failed."); process.exit(1); }
const restart = RESTART_CMD || "mkdir -p tmp && touch tmp/restart.txt";
const remote = spawnSync("ssh", ["-p", PORT, `${USER}@${HOST}`, `cd ${APP_DIR} && tar -xzf release.tar.gz && rm release.tar.gz && ${restart}`], { stdio: "inherit" });
if (remote.status !== 0) { console.error("Remote extract/restart failed."); process.exit(1); }
await rm(staging, { recursive: true, force: true });
console.log("Release uploaded and extracted beside protected state; app restart requested. Verify health before any go-live decision.");
