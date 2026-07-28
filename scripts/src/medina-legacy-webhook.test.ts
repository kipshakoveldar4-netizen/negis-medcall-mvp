import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2A — the legacy lead intake webhook is disabled.
//
// Before disabling it, the repository was searched for callers: the frontend
// never references the path, no documentation configures it, and the only other
// occurrence (artifacts/api-server) is not referenced by vercel.json,
// railway.json or the root package.json. The handler also wrote a `clinic_id`
// column that the applied leads schema does not have, so it could not succeed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const handlerPath = path.join(repoRoot, "api", "leads", "webhook", "[clinicId].ts");

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => MockResponse;
  setHeader: (key: string, value: string) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    headers: {},
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const handlerModule = (await import(pathToFileURL(handlerPath).href)) as {
  default: (req: unknown, res: MockResponse) => unknown;
  config?: { api?: { bodyParser?: boolean } };
};

function invoke(req: Record<string, unknown>): MockResponse {
  const res = mockResponse();
  handlerModule.default(req, res);
  return res;
}

test("01 POST returns 410 Gone", () => {
  const res = invoke({ method: "POST", query: { clinicId: "clinic-1" }, body: { phone: "+77010000000" } });
  assert.equal(res.statusCode, 410);
});

test("02 every other method gets the same 410 contract", () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const res = invoke({ method, query: { clinicId: "clinic-1" } });
    assert.equal(res.statusCode, 410, `${method} must use the same disabled contract`);
    assert.deepEqual(res.body, {
      success: false,
      error: "This integration endpoint is no longer available",
      code: "legacy_webhook_disabled",
    });
  }
});

test("03 the response discloses no schema, database or clinic detail", () => {
  const res = invoke({ method: "POST", query: { clinicId: "clinic-1" }, body: { phone: "+77010000000" } });
  const serialized = JSON.stringify(res.body).toLowerCase();
  for (const forbidden of [
    "supabase",
    "postgres",
    "leads",
    "clinic_id",
    "workspace_id",
    "phone_normalized",
    "column",
    "table",
    "schema",
    "service_role",
    "does not exist",
  ]) {
    assert.ok(!serialized.includes(forbidden), `the disabled response must not mention ${forbidden}`);
  }
});

test("04 every clinic id receives an identical response", () => {
  const ids = ["clinic-1", "00000000-0000-4000-8000-000000000000", "", "../etc/passwd", "'; drop table leads; --"];
  const bodies = ids.map((clinicId) => JSON.stringify(invoke({ method: "POST", query: { clinicId } }).body));
  const statuses = ids.map((clinicId) => invoke({ method: "POST", query: { clinicId } }).statusCode);
  assert.equal(new Set(bodies).size, 1, "the body must not vary by clinic id");
  assert.equal(new Set(statuses).size, 1, "the status must not vary by clinic id");
});

test("05 a large or malformed body changes nothing", () => {
  const huge = { phone: "9".repeat(100000), nested: { deep: Array.from({ length: 1000 }, (_, i) => i) } };
  const res = invoke({ method: "POST", query: { clinicId: "clinic-1" }, body: huge });
  assert.equal(res.statusCode, 410);
  assert.equal((res.body as { code: string }).code, "legacy_webhook_disabled");
});

test("06 the handler builds no Supabase client and reads no service-role key", async () => {
  const source = await readFile(handlerPath, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "createClient",
    "@supabase/supabase-js",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
    "getSupabaseServerClient",
  ]) {
    assert.ok(!code.includes(forbidden), `the disabled webhook must not reference ${forbidden}`);
  }
});

test("07 the handler performs no database operation", async () => {
  const source = await readFile(handlerPath, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of [".from(", ".insert(", ".update(", ".delete(", ".select(", ".upsert("]) {
    assert.ok(!code.includes(forbidden), `the disabled webhook must not call ${forbidden}`);
  }
});

test("08 the request body is never parsed", () => {
  assert.equal(
    handlerModule.config?.api?.bodyParser,
    false,
    "bodyParser must stay off so submitted fields are never materialised",
  );
});

test("09 the route offers no replacement and no redirect", async () => {
  const source = await readFile(handlerPath, "utf8");
  const res = invoke({ method: "POST", query: { clinicId: "clinic-1" } });
  assert.ok(!("location" in res.headers), "a disabled endpoint must not redirect");
  assert.ok(!("Location" in res.headers), "a disabled endpoint must not redirect");
  const serialized = JSON.stringify(res.body).toLowerCase();
  for (const forbidden of ["http://", "https://", "instead", "use /api", "migrate to"]) {
    assert.ok(!serialized.includes(forbidden), `the response must not advertise ${forbidden}`);
  }
  assert.ok(!source.includes("res.redirect"), "no redirect helper may be used");
});

test("10 the Vercel route mapping is left untouched so this file stays terminal", async () => {
  const vercel = await readFile(path.join(repoRoot, "vercel.json"), "utf8");
  assert.ok(
    vercel.includes("/api/leads/webhook/[clinicId].ts"),
    "the mapping must remain so the path resolves to the disabled handler",
  );
});
