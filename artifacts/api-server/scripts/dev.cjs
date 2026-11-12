const { spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";
const pnpmCommand = isWindows ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_ENV: "development" };

function run(args) {
  const result = spawnSync(pnpmCommand, args, {
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

run(["run", "build"]);
run(["run", "start"]);
