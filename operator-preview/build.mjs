import { spawnSync } from "node:child_process";
import { requireOperatorPreview } from "./profile.mjs";

requireOperatorPreview(process.env, "build");
const env = {
  NODE_ENV: "production",
  VITE_API_BASE_URL: "/",
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|corepack_home)$/i.test(key)) env[key] = value;
}
const args = ["--filter", "@workspace/negis", "run", "build"];
const windowsPnpm = process.platform === "win32" ? process.env.npm_execpath : undefined;
if (process.platform === "win32" && !windowsPnpm) throw new Error("Operator Preview build needs pnpm's Node entrypoint on Windows.");
const result = spawnSync(windowsPnpm ? process.execPath : "pnpm", windowsPnpm ? [windowsPnpm, ...args] : args, {
  env, stdio: "inherit", shell: false,
});
process.exitCode = result.status ?? 1;
