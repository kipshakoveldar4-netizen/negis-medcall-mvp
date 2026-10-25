const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  if (process.argv.length !== 2) throw new Error("This runner accepts no extra arguments or entrypoints");
  const root = path.resolve(__dirname, "..");
  const plan = await import(pathToFileURL(path.join(__dirname, "fixtures/readiness-isolation-profile.mjs")).href);
  plan.verifyReaderSnapshot(root);
  for (const file of plan.isolatedTestFiles) {
    if (!fs.existsSync(path.join(root, file))) throw new Error("Required local isolation test is missing");
  }
  // Read only named OS plumbing, not application settings or credentials.
  const system = Object.create(null);
  for (const key of plan.permittedSystemKeys) if (process.env[key] !== undefined) system[key] = process.env[key];
  const result = spawnSync(process.execPath, [
    "--require", path.join(__dirname, "fixtures/readiness-no-network.cjs"),
    "--experimental-transform-types",
    "--test", "--test-concurrency=1", ...plan.isolatedTestFiles,
  ], { cwd: root, env: plan.syntheticProcessEnvironment(system), stdio: "inherit", shell: false });
  if (result.error) throw new Error("Unable to start the local isolation test process");
  process.exitCode = result.status ?? 1;
}
main().catch(() => { console.error("Local isolation runner refused; no application was started."); process.exitCode = 1; });
