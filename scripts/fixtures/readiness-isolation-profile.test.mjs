import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { falseFlags, isolatedTestFiles, omittedBindings, permittedSystemKeys, prohibitedEntrypoints, sourceBaseline, syntheticProcessEnvironment, verifyReaderSnapshot } from "./readiness-isolation-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preload = path.join(root, "scripts/fixtures/readiness-no-network.cjs");
const child = (code, system = {}) => spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", code], {
  cwd: root, env: syntheticProcessEnvironment(system), encoding: "utf8", timeout: 10000, shell: false,
});

test("41 exact normalized reader sources match this local baseline; any drift refuses", () => {
  assert.equal(verifyReaderSnapshot(root), 41);
  assert.throws(() => verifyReaderSnapshot(root, file => fs.readFileSync(path.join(root, file), "utf8")
    + (file === "lib/ai/text-provider.ts" ? "\n// synthetic drift" : "")), /Isolation reader changed: lib\/ai\/text-provider\.ts/);
});

test("profile is explicitly local, complete for its own omission list, and never inherits poison", () => {
  assert.equal(sourceBaseline, "41865a8");
  assert.equal(new Set(omittedBindings).size, omittedBindings.length);
  const poisoned = Object.fromEntries([...omittedBindings, "UNLISTED_SECRET", "HOME", "USERPROFILE", "APPDATA"].map(key => [key, "SYNTHETIC_POISON"]));
  const result = syntheticProcessEnvironment(poisoned);
  for (const key of Object.keys(poisoned)) assert.equal(Object.hasOwn(result, key), false, key);
  for (const key of falseFlags) assert.equal(result[key], "false", key);
  assert.equal(result.VITE_API_BASE_URL, "/");
  assert.equal(result.TARGETING_AGENT_URL, "http://127.0.0.1:1");
  assert.equal(result.NODE_ENV, "test");assert.equal(result.TZ, "UTC");
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_POISON"), false);
});

test("profile reads only explicitly permitted OS properties and returns a fresh record", () => {
  const system = { PATH: "synthetic-path", TEMP: "synthetic-temp" };
  Object.defineProperty(system, "OPENAI_API_KEY", { get() { assert.fail("A credential was read"); } });
  const one = syntheticProcessEnvironment(system), two = syntheticProcessEnvironment(system);
  assert.equal(one.PATH, system.PATH);assert.equal(one.TEMP, system.TEMP);
  one.OPENAI_API_KEY = "synthetic-change"; assert.equal(Object.hasOwn(two, "OPENAI_API_KEY"), false);
});

test("the actual Node preload removes OS-injected user bindings as well as inherited application poison", () => {
  const poison = { OPENAI_API_KEY: "SYNTHETIC_POISON", SUPABASE_SERVICE_ROLE_KEY: "SYNTHETIC_POISON", NODE_OPTIONS: "--synthetic-invalid-option", UNLISTED_SECRET: "SYNTHETIC_POISON" };
  const result = child("console.log(JSON.stringify(Object.keys(process.env).sort()))", poison);
  assert.equal(result.error, undefined);assert.equal(result.status, 0, result.stderr);
  const keys = JSON.parse(result.stdout).map(key => key.toUpperCase());
  const expected = Object.keys(syntheticProcessEnvironment(poison)).map(key => key.toUpperCase());
  const allowed = new Set([...expected, ...permittedSystemKeys.map(key => key.toUpperCase())]);
  for (const key of keys) assert.ok(allowed.has(key), `Unexpected key after preload: ${key}`);
  for (const key of expected) assert.ok(keys.includes(key), `Required synthetic binding missing: ${key}`);
  assert.equal(result.stderr, "");assert.doesNotMatch(result.stdout, /SYNTHETIC_POISON|UNLISTED_SECRET|OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|NODE_OPTIONS|USERPROFILE|HOMEDRIVE|HOMEPATH|LOGONSERVER|USERNAME|USERDOMAIN/i);
});

test("approved runner entrypoints never include an application, worker, CLI or cloud script", () => {
  for (const file of isolatedTestFiles) {
    assert.match(file, /^scripts\/(fixtures|src)\/[a-z0-9-]+\.test\.(mjs|ts)$/);
    assert.equal(prohibitedEntrypoints.includes(file), false);
  }
  const runner = fs.readFileSync(path.join(root, "scripts/run-readiness-isolation.cjs"), "utf8");
  assert.match(runner, /process\.argv\.length !== 2/);
  assert.match(runner, /env: plan\.syntheticProcessEnvironment\(system\)/);
  assert.doesNotMatch(runner, /env: process\.env|\.\.\.process\.env|dotenv|--prod/);
});

test("runner refuses an extra entrypoint before any application starts", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/run-readiness-isolation.cjs"), "--synthetic-unapproved-entry"], {
    cwd: root, env: syntheticProcessEnvironment(), encoding: "utf8", timeout: 10000, shell: false,
  });
  assert.equal(result.error, undefined);assert.equal(result.status, 1);
  assert.equal(result.stdout, "");assert.match(result.stderr, /^Local isolation runner refused; no application was started\.\s*$/);
});

test("a no-network child can run a pure reader without a network attempt", () => {
  const result = child("import assert from 'node:assert/strict'; assert.equal(2+2,4); console.log('synthetic-only');");
  assert.equal(result.error, undefined);assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "synthetic-only");assert.equal(result.stderr, "");
});

const routes = {
  fetch: "await fetch('https://do-not-dispatch.invalid/private?token=SYNTHETIC_POISON')",
  http: "(await import('node:http')).get('http://do-not-dispatch.invalid')",
  https: "(await import('node:https')).request('https://do-not-dispatch.invalid')",
  http2: "(await import('node:http2')).connect('https://do-not-dispatch.invalid')",
  net: "(await import('node:net')).connect(80,'do-not-dispatch.invalid')",
  socket: "new (await import('node:net')).Socket().connect(80,'do-not-dispatch.invalid')",
  listener: "(await import('node:http')).createServer().listen(0,'127.0.0.1')",
  tls: "(await import('node:tls')).connect(443,'do-not-dispatch.invalid')",
  dns: "(await import('node:dns')).lookup('do-not-dispatch.invalid',()=>{})",
  dnsPromises: "await (await import('node:dns/promises')).resolveTxt('do-not-dispatch.invalid')",
  resolver: "new (await import('node:dns')).Resolver().resolveTxt('do-not-dispatch.invalid',()=>{})",
  resolverPromises: "await new (await import('node:dns/promises')).Resolver().resolveTxt('do-not-dispatch.invalid')",
  udp: "(await import('node:dgram')).createSocket('udp4')",
  websocket: "new WebSocket('wss://do-not-dispatch.invalid')",
};
for (const [name, expression] of Object.entries(routes)) {
  test(`caught ${name} attempt still fails the owned process and logs no payload`, () => {
    const result = child(`try { ${expression}; } catch (error) { if(error.code!=='MEDINA_SYNTHETIC_NETWORK_DENIED') throw error; }`);
    assert.equal(result.error, undefined);assert.equal(result.status, 86, result.stderr);
    assert.match(result.stderr, /Synthetic network attempts refused:/);
    assert.doesNotMatch(result.stderr + result.stdout, /SYNTHETIC_POISON|do-not-dispatch/);
  });
}
