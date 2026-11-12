const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const userAgent = process.env.npm_config_user_agent || "";

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  const lockfilePath = path.join(rootDir, lockfile);
  if (fs.existsSync(lockfilePath)) {
    fs.rmSync(lockfilePath, { force: true });
  }
}

if (!userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
