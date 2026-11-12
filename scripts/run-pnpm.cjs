const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const npmExecPath = process.env.npm_execpath;

let command;
let commandArgs;

if (npmExecPath) {
  command = process.execPath;
  commandArgs = [npmExecPath, ...args];
} else {
  command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  commandArgs = args;
}

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  shell: false,
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
