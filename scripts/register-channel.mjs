// Registers the channel bridge (server/channel.mjs) with Claude Code at user scope, using absolute
// paths and the node binary running this script, so Claude Code does not depend on its working
// directory or PATH (nvm etc.) to start it.
//
//   npm run channel:register
//
// Inside WSL it does not register anything: Claude Code may run on Windows, so it prints the
// command to run there (Windows Claude Code then starts the bridge inside WSL through wsl.exe).
// Set CANVAS_URL to point the bridge at a canvas server other than http://127.0.0.1:4317.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "visual-canvas-channel";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(root, "server", "channel.mjs");
if (!existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  console.error(`Run npm install in ${root} first.`);
  process.exit(1);
}
const url = process.env.CANVAS_URL;

const distro = process.env.WSL_DISTRO_NAME;
if (distro) {
  // The bridge runs inside WSL (this node, these files), reaching the canvas server at 127.0.0.1.
  // --exec, not -e: `claude mcp add` took a bare -e for its own --env option and dropped the script path.
  const inWsl = [process.execPath, bridge];
  const viaWsl = ["wsl.exe", "-d", distro, "--exec", ...(url ? ["env", `CANVAS_URL=${url}`] : []), ...inWsl];
  let windowsPath;
  try {
    windowsPath = execFileSync("wslpath", ["-w", bridge], { encoding: "utf8" }).trim();
  } catch {
    // not translatable (file inside the WSL filesystem): only the wsl.exe variant applies
  }
  console.log(`Inside WSL (${distro}). Run this where Claude Code runs:\n`);
  console.log("Claude Code on Windows (PowerShell or cmd), bridge runs in WSL:");
  console.log(`  claude mcp remove ${NAME} --scope user`);
  console.log(`  claude mcp add --scope user ${NAME} -- ${viaWsl.map(quote).join(" ")}\n`);
  if (windowsPath) {
    console.log("Or, if Node.js is installed on Windows, run the bridge there:");
    console.log(`  claude mcp add --scope user ${url ? `-e CANVAS_URL=${url} ` : ""}${NAME} -- node ${quote(windowsPath)}\n`);
  }
  console.log("Claude Code inside WSL: run this script with --here to register directly.\n");
  console.log(`Then start Claude Code with:\n  claude --dangerously-load-development-channels server:${NAME}`);
  if (!process.argv.includes("--here")) process.exit(0);
}

const shell = process.platform === "win32";
spawnSync("claude", ["mcp", "remove", NAME, "--scope", "user"], { stdio: "ignore", shell }); // may not exist yet
const env = url ? ["-e", `CANVAS_URL=${url}`] : [];
const res = spawnSync("claude", ["mcp", "add", "--scope", "user", ...env, NAME, "--", process.execPath, bridge], { stdio: "inherit", shell });
if (res.error) {
  console.error(`Could not run the claude CLI (${res.error.message}). Register it yourself:`);
  console.error(`  claude mcp add --scope user ${NAME} -- ${quote(process.execPath)} ${quote(bridge)}`);
  process.exit(1);
}
if (res.status === 0) console.log(`\nRegistered. Start Claude Code with:\n  claude --dangerously-load-development-channels server:${NAME}`);
process.exit(res.status ?? 1);

function quote(arg) {
  return /^[\w.:\\/=@+-]+$/.test(arg) ? arg : `"${arg}"`;
}
