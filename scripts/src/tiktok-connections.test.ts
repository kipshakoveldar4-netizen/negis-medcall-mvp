import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Row = { workspace_id: string; advertiser_id: string; currency: string; account_timezone: string; enabled: boolean; verified_at: string };
type Summary = { state: string; saved: boolean; launchEnabled: false; verifiedAt?: string };
type Diagnostic = { connected: boolean; advertiser?: { currency: string; timezone: string }; message?: string };
type Store = { find(id: string): Promise<Row | null>; save(row: Omit<Row, "enabled">): Promise<void> };
type Module = {
  createTikTokConnectionService(options: {
    env: Record<string, string>; store: Store; now: () => number; validate: () => Promise<Diagnostic>;
  }): { read(id: string): Promise<Summary>; connect(id: string): Promise<Summary> };
};
const imported = await import(pathToFileURL(path.join(root, "lib/tiktok/connections.ts")).href);
const { createTikTokConnectionService } = ((imported as { default?: unknown }).default ?? imported) as Module;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const account = "7123456789012345678";
const now = Date.parse("2026-09-05T10:00:00.000Z");
function fixture() {
  const env = { TIKTOK_WORKSPACE_ID: A, TIKTOK_ADVERTISER_ID: account, TIKTOK_ACCESS_TOKEN: "secret-not-in-storage" };
  const rows = new Map<string, Row>();
  let time = now;
  let checks = 0;
  let queries = 0;
  const writes: unknown[] = [];
  let diagnostic: Diagnostic = { connected: true, advertiser: { currency: "KZT", timezone: "Asia/Almaty" } };
  const store: Store = {
    async find(id) { queries++; return rows.get(id) ?? null; },
    async save(row) { writes.push(row); rows.set(row.workspace_id, { ...row, enabled: rows.get(row.workspace_id)?.enabled ?? true }); },
  };
  const service = createTikTokConnectionService({ env, store, now: () => time,
    validate: async () => { checks++; return diagnostic; } });
  return { env, rows, store, service, writes, setTime(value: number) { time = value; },
    setDiagnostic(value: Diagnostic) { diagnostic = value; }, counts: () => ({ queries, checks }) };
}
const errorCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code); return true;
};

test("workspace assignment is checked before storage or provider; browser ownership cannot claim another account", async () => {
  const f = fixture();
  await assert.rejects(f.service.read(B), errorCode("workspace_not_authorized"));
  await assert.rejects(f.service.connect(B), errorCode("workspace_not_authorized"));
  assert.deepEqual(f.counts(), { queries: 0, checks: 0 });
  f.env.TIKTOK_WORKSPACE_ID = "";
  await assert.rejects(f.service.connect(A), errorCode("workspace_not_provisioned"));
  assert.deepEqual(f.counts(), { queries: 0, checks: 0 });
});

test("connection is saved only after provider verification; read is passive and response/storage contain no credentials", async () => {
  const f = fixture();
  assert.equal((await f.service.read(A)).state, "not_connected");
  assert.equal(f.counts().checks, 0);
  const summary = await f.service.connect(A);
  assert.equal(summary.state, "connected");
  assert.equal(summary.saved, true);
  assert.equal(summary.launchEnabled, false);
  assert.equal(f.writes.length, 1);
  assert.equal((await f.service.read(A)).state, "connected");
  assert.equal(f.counts().checks, 1);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(`${account}|secret-not-in-storage|accessToken|https:`));
  assert.doesNotMatch(JSON.stringify(f.writes), /secret-not-in-storage|accessToken|access_token|app_secret|raw_payload/);
  await f.service.connect(A);
  assert.equal(f.rows.size, 1);
});

test("stale verification does not authorize setup; repeated check renews only the same binding", async () => {
  const f = fixture();
  await f.service.connect(A);
  f.setTime(now + 86_400_000);
  assert.equal((await f.service.read(A)).state, "needs_verification");
  assert.equal((await f.service.connect(A)).state, "connected");
  f.env.TIKTOK_ADVERTISER_ID = "7987654321098765432";
  assert.equal((await f.service.read(A)).state, "configuration_changed");
  const checks = f.counts().checks;
  await assert.rejects(f.service.connect(A), errorCode("connection_conflict"));
  assert.equal(f.counts().checks, checks);
  assert.equal(f.rows.get(A)?.advertiser_id, account);
});

test("revoked binding and unavailable provider do not revive a connection or write success", async () => {
  const f = fixture();
  f.setDiagnostic({ connected: false, message: "TikTok отклонил токен доступа." });
  await assert.rejects(f.service.connect(A), errorCode("account_verification_failed"));
  assert.equal(f.writes.length, 0);
  f.setDiagnostic({ connected: true, advertiser: { currency: "KZT", timezone: "Asia/Almaty" } });
  await f.service.connect(A);
  f.rows.get(A)!.enabled = false;
  assert.equal((await f.service.read(A)).state, "disabled");
  await assert.rejects(f.service.connect(A), errorCode("connection_conflict"));
  assert.equal(f.writes.length, 1);
});

test("storage exceptions and missing schema fail closed without raw errors or demo success", async () => {
  const f = fixture();
  f.store.find = async () => { throw new Error("PGRST205 https://private.test service_role=secret"); };
  await assert.rejects(f.service.read(A), (error: unknown) => {
    assert.equal((error as { code: string }).code, "connection_storage_unavailable");
    assert.doesNotMatch(String(error), /private.test|service_role|PGRST205/);
    return true;
  });
  await assert.rejects(f.service.connect(A), errorCode("connection_storage_unavailable"));
  assert.equal(f.counts().checks, 0);
});

test("invalid metadata and persistence failure cannot become a saved connection", async () => {
  const f = fixture();
  f.setDiagnostic({ connected: true, advertiser: { currency: "invalid", timezone: "" } });
  await assert.rejects(f.service.connect(A), errorCode("account_metadata_invalid"));
  assert.equal(f.writes.length, 0);
  f.setDiagnostic({ connected: true, advertiser: { currency: "KZT", timezone: "Asia/Almaty" } });
  f.store.save = async () => { throw new Error("secret database failure"); };
  await assert.rejects(f.service.connect(A), errorCode("connection_storage_unavailable"));
  assert.equal(f.rows.size, 0);
});

test("migration contract isolates both identifiers, denies client access, and explicitly grants the server", async () => {
  const sql = (await readFile(path.join(root, "migrations/047_tiktok_ad_account_connections.sql"), "utf8"))
    .replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  assert.match(sql, /workspace_id uuid not null unique references public.workspaces/);
  assert.match(sql, /advertiser_id text not null unique/);
  assert.match(sql, /unique\(workspace_id, advertiser_id\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all .* from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update .* to service_role/);
  assert.doesNotMatch(sql, /access_token|app_secret|raw_payload|create policy/);
});
