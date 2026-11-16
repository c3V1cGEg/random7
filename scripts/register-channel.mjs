// Registers the channel bridge with Claude Code (user scope) using absolute paths: this repo's
// tsx and server/channel.ts, and the node binary running this script, so Claude Code does not
// depend on its own working directory or PATH (nvm etc.) to start it.
//   npm run channel:register             (CANVAS_URL=http://127.0.0.1:4317 by default)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "visual-canvas-channel";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const bridge = path.join(root, "server", "channel.ts");
for (const file of [tsx, bridge]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run npm install in ${root} first.`);
    process.exit(1);
  }
}

const env = process.env.CANVAS_URL ? ["-e", `CANVAS_URL=${process.env.CANVAS_URL}`] : [];
const run = (args) => spawnSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });

// Replace an earlier registration (it may point at old paths); ignore "not found".
spawnSync("claude", ["mcp", "remove", NAME, "--scope", "user"], { stdio: "ignore", shell: process.platform === "win32" });
const res = run(["mcp", "add", "--scope", "user", ...env, NAME, "--", process.execPath, tsx, bridge]);
if (res.error) {
  console.error(`Could not run the claude CLI (${res.error.message}). Register it yourself:`);
  console.error(`  claude mcp add --scope user ${NAME} -- "${process.execPath}" "${tsx}" "${bridge}"`);
  process.exit(1);
}
if (res.status === 0) {
  console.log(`\nRegistered. Start Claude Code with:\n  claude --dangerously-load-development-channels server:${NAME}`);
}
process.exit(res.status ?? 1);
