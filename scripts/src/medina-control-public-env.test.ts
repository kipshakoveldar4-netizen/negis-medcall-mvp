import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { resolveControlBrowserEnv } = (await import(
  pathToFileURL(
    path.join(root, "artifacts/medina-control/src/lib/control-config.ts"),
  ).href
)) as {
  resolveControlBrowserEnv(
    env: Record<string, string | undefined>,
    development?: boolean,
  ): Record<string, string>;
};
const env = {
  VITE_MEDINA_CONTROL_MODE: "isolated-preview",
  VITE_MEDINA_API_URL:
    "https://negis-medcall-mvp-api-server-abc123def-yeldar-s-projects.vercel.app",
  VITE_SUPABASE_URL: "https://ukiobbwsdoblooynzlnx.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_local_fixture",
};
const empty = Object.fromEntries(Object.keys(env).map((key) => [key, ""]));

test("Only four validated public values may be serialized for the browser", () => {
  assert.deepEqual(
    resolveControlBrowserEnv(
      {
        ...env,
        VITE_OTHER_SECRET: "local-secret-marker",
        SERVER_KEY: "server-marker",
      },
      true,
    ),
    env,
  );
  assert.deepEqual(
    resolveControlBrowserEnv(
      {
        ...env,
        VITE_MEDINA_API_URL: `${env.VITE_MEDINA_API_URL}/`,
        VITE_SUPABASE_ANON_KEY: ` ${env.VITE_SUPABASE_ANON_KEY} `,
      },
      true,
    ),
    env,
  );
});

test("Invalid private keys and other tainted configuration never enter browser defines", () => {
  const serviceRole = `a.${Buffer.from(JSON.stringify({ role: "service_role", marker: "local-secret-marker" })).toString("base64url")}.b`;
  for (const override of [
    { VITE_SUPABASE_ANON_KEY: "sb_secret_local-secret-marker" },
    { VITE_SUPABASE_ANON_KEY: serviceRole },
    { VITE_MEDINA_API_URL: "https://local-secret-marker@example.test" },
    {
      VITE_MEDINA_API_URL: `${env.VITE_MEDINA_API_URL}/?key=local-secret-marker`,
    },
    { VITE_MEDINA_CONTROL_MODE: "local-secret-marker" },
    { VITE_SUPABASE_URL: "https://foreign-fixture.supabase.co" },
  ]) {
    assert.deepEqual(
      resolveControlBrowserEnv({ ...env, ...override }, true),
      empty,
    );
  }
});

test("Vite automatic VITE environment exposure is disabled and defines use the sanitizer", async () => {
  const source = await readFile(
    path.join(root, "artifacts/medina-control/vite.config.ts"),
    "utf8",
  );
  assert.match(source, /envPrefix:\s*\[\s*\]/);
  assert.match(
    source,
    /const browserEnv = resolveControlBrowserEnv\(\s*configuredEnv,\s*command === "serve",?\s*\)/,
  );
  assert.match(source, /Object\.entries\(browserEnv\)/);
});
