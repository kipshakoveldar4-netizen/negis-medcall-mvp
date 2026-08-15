import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// MC — портал Medina Control и кросс-доменный доступ к API.
//
// Портал живёт на другом домене и ходит в тот же API. Единственное, что для
// этого открылось, — CORS для источников из переменной окружения. Набор
// закрепляет умолчание-отказ: пустая переменная означает «как раньше», а не
// «пускать всех», и preflight отвечает только перечисленным адресам.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const controlSrc = path.join(repoRoot, "artifacts", "medina-control", "src");

type CorsModule = {
  parseControlOrigins: (raw: string | undefined) => string[];
  applyControlCors: (req: unknown, res: unknown, env?: NodeJS.ProcessEnv) => "none" | "allowed" | "preflight";
  CONTROL_ORIGINS_ENV: string;
};

const { applyControlCors, parseControlOrigins, CONTROL_ORIGINS_ENV } = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "auth", "cors.ts")).href
)) as CorsModule;

async function allSources(dir: string): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<[string, string]> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await allSources(full)));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) files.push([full, await readFile(full, "utf8")]);
  }
  return files;
}

type FakeReq = { headers: Record<string, string>; method: string };
type SetHeaderCall = [string, string];

function fakeReqRes(origin: string, method: string) {
  const headers: SetHeaderCall[] = [];
  const req = { headers: origin ? { origin } : {}, method } as unknown as Parameters<typeof applyControlCors>[0];
  const res = {
    setHeader(name: string, value: string) {
      headers.push([name, value]);
      return res;
    },
  } as unknown as Parameters<typeof applyControlCors>[1];
  return { req, res, headers };
}

test("MC1 разбор источников: только полные origin, мусор отбрасывается молча", () => {
  assert.deepEqual(parseControlOrigins(undefined), []);
  assert.deepEqual(parseControlOrigins(""), []);
  assert.deepEqual(parseControlOrigins("замените_меня"), []);
  assert.deepEqual(parseControlOrigins("*"), []);
  assert.deepEqual(parseControlOrigins("ftp://x.example"), []);
  assert.deepEqual(
    parseControlOrigins("https://control.example.com/, http://localhost:5174"),
    ["https://control.example.com", "http://localhost:5174"],
  );
});

test("MC2 пустой список означает «как раньше»: ни заголовков, ни preflight", () => {
  const { req, res, headers } = fakeReqRes("https://control.example.com", "OPTIONS");
  const outcome = applyControlCors(req, res, {} as NodeJS.ProcessEnv);
  assert.equal(outcome, "none");
  assert.equal(headers.length, 0, "без переменной окружения ответ не меняется вовсе");
});

test("MC3 чужой источник не узнаёт о существовании списка", () => {
  const env = { [CONTROL_ORIGINS_ENV]: "https://control.example.com" } as unknown as NodeJS.ProcessEnv;
  const { req, res, headers } = fakeReqRes("https://evil.example.com", "OPTIONS");
  assert.equal(applyControlCors(req, res, env), "none");
  assert.equal(headers.length, 0);
});

test("MC4 разрешённый источник получает конкретный origin и preflight", () => {
  const env = { [CONTROL_ORIGINS_ENV]: "https://control.example.com" } as unknown as NodeJS.ProcessEnv;

  const preflight = fakeReqRes("https://control.example.com", "OPTIONS");
  assert.equal(applyControlCors(preflight.req, preflight.res, env), "preflight");
  const allowOrigin = preflight.headers.find(([name]) => name === "Access-Control-Allow-Origin");
  assert.deepEqual(allowOrigin, ["Access-Control-Allow-Origin", "https://control.example.com"], "origin конкретный, не «*»");
  assert.ok(preflight.headers.some(([name]) => name === "Vary"), "Vary: Origin обязателен для кэшей");
  assert.ok(
    preflight.headers.some(([name, value]) => name === "Access-Control-Allow-Headers" && value.includes("Authorization")),
    "браузеру разрешён заголовок с токеном",
  );

  const request = fakeReqRes("https://control.example.com", "GET");
  assert.equal(applyControlCors(request.req, request.res, env), "allowed");
});

test("MC5 роутер завершает preflight до всякой авторизации", async () => {
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  const corsAt = router.indexOf("applyControlCors(req, res)");
  assert.ok(corsAt > 0, "роутер зовёт CORS-слой");
  assert.ok(corsAt < router.indexOf("resolveCrmRoute(segments)"), "и раньше разбора маршрута");
  assert.ok(/=== "preflight"[\s\S]{0,80}status\(204\)/.test(router), "preflight — пустой 204");
});

test("MC6 у портала нет секретов и токена в адресе", async () => {
  const sources = await allSources(controlSrc);
  assert.ok(sources.length >= 5, "исходники портала на месте");
  for (const [file, source] of sources) {
    const name = path.relative(controlSrc, file);
    assert.ok(!/SERVICE_ROLE/i.test(source), `${name}: у портала не может быть служебного ключа`);
    assert.ok(!/[?&]token=/.test(source), `${name}: токен не ходит в адресе`);
  }
  const api = sources.find(([file]) => file.endsWith("api.ts"));
  assert.ok(api && api[1].includes('headers.set("Authorization"'), "токен — только в заголовке Authorization");
});

test("MC7 меню портала не обещает ненаписанного", async () => {
  const source = await readFile(path.join(controlSrc, "App.tsx"), "utf8");
  // Комментарии — не интерфейс: судим только код и разметку.
  const app = source.replace(/(^|\s)\/\/.*$/gm, "$1").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
  assert.ok(!app.includes("скоро"), "пунктов-обещаний нет");
  assert.ok(!app.includes("Сигналы") && !app.includes("Рекомендации"), "разделы появятся вместе с кодом, не раньше");
});

test("MC8 маршруты платформы по-прежнему за requirePlatformOwner", async () => {
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  // CORS открыл дорогу браузеру портала, но не ослабил авторизацию: платформенная
  // ветка всё так же требует владельца платформы перед dispatch.
  assert.ok(
    /kind === "platform"[\s\S]{0,700}await requirePlatformOwner\(req\)/.test(router),
    "платформенная ветка требует владельца платформы",
  );
});
