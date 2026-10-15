// `node --check` on every server and script file, one process per file,
// so a syntax error anywhere fails `npm run check` and names the file.
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".mjs")) files.push(full);
  }
};
walk(path.join(root, "server"));
walk(path.join(root, "scripts"));

const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failed.push({ file: path.relative(root, file), error: (result.stderr || "").trim().split("\n").slice(0, 4).join("\n") });
}
console.log(JSON.stringify({ ok: failed.length === 0, checked: files.length, failed }, null, 2));
if (failed.length) process.exit(1);
