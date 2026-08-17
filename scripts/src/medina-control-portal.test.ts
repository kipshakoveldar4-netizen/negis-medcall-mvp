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

type SignalsModule = {
  computeClinicSignals: (facts: {
    subscriptionStatus: string;
    timeZoneSet: boolean;
    doctors: number | null;
    doctorsWithSchedule: number | null;
    services: number | null;
    whatsappChannels: number | null;
    leads7d: number | null;
    appointments7d: number | null;
  }) => Array<{ key: string; level: "ok" | "warn"; data: Record<string, number> }>;
};

const { computeClinicSignals } = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "crm", "clinic-signals.ts")).href
)) as SignalsModule;

const HEALTHY = {
  subscriptionStatus: "active",
  timeZoneSet: true,
  doctors: 2,
  doctorsWithSchedule: 2,
  services: 5,
  whatsappChannels: 1,
  leads7d: 3,
  appointments7d: 4,
};

test("MC10 сигнал не строится на сбое чтения", () => {
  // null — «не смог посчитать». Предупреждение, построенное на сбое, отправило
  // бы владельца чинить клинику, у которой всё в порядке.
  const signals = computeClinicSignals({
    subscriptionStatus: "active",
    timeZoneSet: true,
    doctors: null,
    doctorsWithSchedule: null,
    services: null,
    whatsappChannels: null,
    leads7d: null,
    appointments7d: null,
  });
  assert.deepEqual(signals, [], "по нечитаемым фактам — ни предупреждений, ни успокоений");
});

test("MC11 ноль за неделю — предупреждение, поток — спокойный сигнал", () => {
  const quiet = computeClinicSignals({ ...HEALTHY, appointments7d: 0, leads7d: 0 });
  assert.ok(quiet.some((signal) => signal.key === "no_appointments_7d" && signal.level === "warn"));
  assert.ok(quiet.some((signal) => signal.key === "no_leads_7d" && signal.level === "warn"));

  const flowing = computeClinicSignals(HEALTHY);
  assert.ok(flowing.every((signal) => signal.level === "ok"), "у здоровой клиники нет предупреждений");
  assert.ok(flowing.some((signal) => signal.key === "appointments_flowing" && signal.data.count === 4));
});

test("MC12 график: неполный — предупреждение с числами, пустой справочник — свой сигнал", () => {
  const partial = computeClinicSignals({ ...HEALTHY, doctors: 3, doctorsWithSchedule: 1 });
  const incomplete = partial.find((signal) => signal.key === "schedule_incomplete");
  assert.ok(incomplete && incomplete.level === "warn");
  assert.deepEqual(incomplete?.data, { have: 1, total: 3 });

  const empty = computeClinicSignals({ ...HEALTHY, doctors: 0, doctorsWithSchedule: 0 });
  assert.ok(empty.some((signal) => signal.key === "no_specialists" && signal.level === "warn"));
  assert.ok(!empty.some((signal) => signal.key === "schedule_incomplete"), "про график пустого справочника сигнала нет");

  // Предупреждения стоят раньше спокойных сигналов: карточку открывают ради них.
  const mixed = computeClinicSignals({ ...HEALTHY, whatsappChannels: 0 });
  const firstOkIndex = mixed.findIndex((signal) => signal.level === "ok");
  const lastWarnIndex = mixed.map((signal) => signal.level).lastIndexOf("warn");
  assert.ok(firstOkIndex === -1 || lastWarnIndex < firstOkIndex, "warn раньше ok");
});

test("MC13 карточка клиники зарегистрирована как платформенный маршрут и отдаёт только счётчики", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-clinic": \{ kind: "platform", methods: \["GET"\] \}/.test(registry), "kind platform, только GET");

  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-clinic":\s*return handlePlatformClinic\(req, res\);/.test(router), "роутер диспатчит карточку");

  const handler = await readFile(path.join(repoRoot, "lib", "crm", "platform.ts"), "utf8");
  const card = handler.slice(handler.indexOf("async function handleClinicCard"), handler.indexOf("export async function handlePlatformOverview"));
  assert.ok(card.length > 0, "обработчик на месте");
  // Наружу — счётчики и настройки, ни одной строки пациента: в выборках
  // карточки нет ни телефона, ни имени клиента, ни свободного select(*).
  assert.ok(!/select\("\*"\)/.test(card), "нет select(*)");
  for (const column of ["full_name", "client_name", "phone", "client_phone", "notes"]) {
    assert.ok(!card.includes(`"${column}"`), `колонка ${column} не выбирается`);
  }
  assert.ok(/head: true/.test(card), "счётчики считаются head-запросами");
});

test("MC9 vercel.json портала называет фреймворк и папку сборки", async () => {
  // Первый деплой упал дважды: сначала настройки импорта собирали чужое
  // приложение, потом слетевший пресет искал папку public. Конфиг в
  // репозитории переживает любые клики в панели Vercel.
  const config = JSON.parse(
    await readFile(path.join(repoRoot, "artifacts", "medina-control", "vercel.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(config.framework, "vite");
  assert.equal(config.outputDirectory, "dist");
});

test("MC14 платформенный маршрут не выдаёт себя ни методом, ни статусом", async () => {
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  const platformBranch = router.slice(
    router.indexOf('route.authorization.kind === "platform"'),
    router.indexOf("if (!isDisabledMethod"),
  );
  // POST на платформенный путь отвечал 405, на несуществующий — 404: оракул
  // существования панели без единого токена. Гейт обязан стоять до проверки
  // метода, а любой авторизационный отказ — превращаться в тот же 404.
  const gateAt = platformBranch.indexOf("requirePlatformOwner(req)");
  const methodCheckAt = platformBranch.indexOf("methodNotAllowed(res)");
  assert.ok(gateAt > 0 && methodCheckAt > 0, "гейт и проверка метода в платформенной ветке");
  assert.ok(gateAt < methodCheckAt, "сначала владелец платформы, потом 405");
  assert.ok(
    /error instanceof PlatformAuthError \|\| error instanceof WorkspaceAdminAuthError[\s\S]{0,80}notFound\(res\)/.test(platformBranch),
    "отказ авторизации на платформенном маршруте — тот же 404, что у неизвестного пути",
  );
});

test("MC15 карточка собирает доступ: сотрудники, приглашение владельца и перевыпуск на месте", async () => {
  const handler = await readFile(path.join(repoRoot, "lib", "crm", "platform.ts"), "utf8");
  const card = handler.slice(handler.indexOf("async function handleClinicCard"), handler.indexOf("export async function handlePlatformOverview"));
  assert.ok(/access: \{ staff: staffRows, ownerInvitations: invitationRows \}/.test(card), "доступ в ответе карточки");
  // Сбой чтения — null, не пустой список: «не смог прочитать» не имеет права
  // выглядеть как «в клинике никого нет». Колонки пациентов в этих выборках
  // запрещает MC13 — блок доступа лежит внутри того же среза.
  const staffBlock = card.slice(card.indexOf('from("staff_users")'), card.indexOf('from("staff_invitations")'));
  assert.ok(/if \(error \|\| !Array\.isArray\(data\)\) return null;/.test(staffBlock), "отказ чтения сотрудников — null");
  const invitationBlock = card.slice(card.indexOf('from("staff_invitations")'));
  assert.ok(/if \(error \|\| !Array\.isArray\(data\)\) return null;/.test(invitationBlock), "отказ чтения приглашений — null");
  assert.ok(/\.eq\("role", "owner"\)/.test(invitationBlock), "карточке видны только приглашения владельца");

  const screen = await readFile(path.join(controlSrc, "screens", "ClinicCard.tsx"), "utf8");
  assert.ok(screen.includes("platform-invitation-reissue"), "перевыпуск доступен прямо с карточки");
  assert.ok(screen.includes("Перевыпустить приглашение"), "кнопка называет действие");
  assert.ok(/ownerInside \?/.test(screen), "принявшему владельцу кнопку не обещают — сервер бы отказал");
  assert.ok(
    /accessStaff === null \?/.test(screen) && /accessStaff\.length === 0 \?/.test(screen),
    "null и пустой список сотрудников — разные состояния на экране",
  );

  // Показанная ссылка живёт ровно до момента, когда сервер сообщил, что она
  // мертва. Стирать по факту любой ошибки нельзя: при отказе на шаге revoke
  // старая ссылка остаётся единственной действующей — поэтому у отказа на
  // шаге insert собственный код, и клиент реагирует именно на коды.
  const onboardingModule = await readFile(path.join(repoRoot, "lib", "crm", "platform-onboarding.ts"), "utf8");
  assert.ok(/code: "reissue_incomplete"/.test(onboardingModule), "отказ после отзыва старых приглашений отличим кодом");
  assert.ok(
    /code === "reissue_incomplete" \|\| code === "owner_already_member"/.test(screen),
    "карточка убирает мёртвую ссылку по кодам сервера, а не по факту ошибки",
  );
});

test("MC16 роль на портале называется тем же словом, что в кабинете клиники", async () => {
  // Каталог ролей один (permissions.ts), и слова к нему должны быть одни:
  // владелец платформы и владелец клиники, называющие одну роль по-разному, —
  // это та самая путаница с назначением сотрудников.
  function parseLabels(source: string, marker: string): Record<string, string> {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `блок ${marker} существует`);
    const block = source.slice(start, source.indexOf("}", start));
    const labels: Record<string, string> = {};
    for (const match of block.matchAll(/(\w+): "([^"]+)"/g)) labels[match[1]] = match[2];
    return labels;
  }
  const cabinet = parseLabels(
    await readFile(path.join(repoRoot, "artifacts", "negis", "src", "lib", "permissions.ts"), "utf8"),
    "export const roleLabels",
  );
  const portal = parseLabels(
    await readFile(path.join(controlSrc, "screens", "ClinicCard.tsx"), "utf8"),
    "const ROLE_LABELS",
  );
  assert.ok(Object.keys(cabinet).length >= 6, "словарь кабинета прочитан");
  assert.deepEqual(portal, cabinet, "одна роль — одно слово на обеих поверхностях");
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
