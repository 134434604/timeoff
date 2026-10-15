// Startup file for the host's Node.js selector, which runs this file
// directly rather than through an npm script, so the env file beside
// package.json is loaded here before the server module runs. Locally
// `npm start` does the same with --env-file-if-exists and skips this file.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const envFile = path.join(ROOT, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
import("./index.mjs").catch((error) => {
  console.error(error);
  process.exit(1);
});
