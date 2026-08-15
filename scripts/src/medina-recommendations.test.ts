import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// MR — рекомендации платформы клиникам (миграция 037).
//
// Единственное, что платформа пишет в сторону клиник. Набор держит три вещи:
// границы арендатора (клиника меняет только свои строки и только статусы),
// окно «деплой раньше миграции» (чтение деградирует к прежнему поведению,
// запись отказывает честно) и запрет внешних ссылок в кнопке совета.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = path.join(repoRoot, "migrations", "037_platform_recommendations.sql");
const modulePath = path.join(repoRoot, "lib", "crm", "recommendations.ts");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const registryPath = path.join(repoRoot, "lib", "crm", "authorization.ts");
const crmComponentPath = path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "PlatformRecommendations.tsx");
const portalCardPath = path.join(repoRoot, "artifacts", "medina-control", "src", "screens", "ClinicCard.tsx");

type RecommendationsModule = {
  isInternalActionPath: (value: string) => boolean;
};

const { isInternalActionPath } = (await import(pathToFileURL(modulePath).href)) as RecommendationsModule;

test("MR1 миграция: статусы, гранты без DELETE, RLS, каскад, путь только внутрь", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.ok(/check \(status in \('sent', 'read', 'done', 'dismissed'\)\)/.test(sql), "статусная модель закрыта");
  assert.ok(/references public\.workspaces\(id\) on delete cascade/.test(sql), "строки уходят вместе с клиникой");
  assert.ok(/enable row level security/.test(sql), "RLS включён");
  assert.ok(/revoke all on table public\.platform_recommendations from anon, authenticated/.test(sql), "браузерным ролям стол не выдан");
  assert.ok(/grant select, insert, update\s+on table public\.platform_recommendations\s+to service_role/.test(sql), "правило паритета: явный грант service_role");
  assert.ok(!/grant[^;]*delete/i.test(sql), "DELETE не выдан: скрытая рекомендация — статус, а не исчезнувшая строка");
  assert.ok(/action_path like '\/%'/.test(sql) && /action_path not like '\/\/%'/.test(sql), "кнопка ведёт только внутрь продукта");
  assert.ok(/position\('\\' in action_path\) = 0/.test(sql), "обратный слэш закрыт и в базе");
  assert.ok(/char_length\(title\) <= 200/.test(sql) && /char_length\(body\) <= 2000/.test(sql), "пределы длины и в базе");
});

test("MR2 маршруты: платформа пишет, клиника читает и отмечает — под своими гейтами", async () => {
  const registry = await readFile(registryPath, "utf8");
  assert.ok(/"platform-recommendations": \{ kind: "platform", methods: \["GET", "POST"\] \}/.test(registry), "платформенная сторона за списком владельцев");
  // Управляющий в списке намеренно: советы касаются прайса, графика и рекламы
  // — его ежедневной работы. Компонент CRM показывает карточки тем же трём
  // ролям; расхождение реестра и компонента делало бы фичу мёртвой молча.
  assert.ok(
    /recommendations: \{ kind: "browser", methods: \["GET", "PATCH"\], roles: \["owner", "admin", "manager"\] \}/.test(registry),
    "клиника — браузерный маршрут для владельца, админа и управляющего",
  );

  const router = await readFile(routerPath, "utf8");
  assert.ok(/case "platform-recommendations":\s*return handlePlatformRecommendations\(req, res\);/.test(router), "диспатч платформы");
  assert.ok(/case "recommendations": \{[\s\S]{0,300}readWorkspaceContext\(req\)[\s\S]{0,200}handleWorkspaceRecommendations\(context \? context\.workspaceId : ""/.test(router), "арендатор клиники — из проверенного контекста");
});

test("MR3 окно «деплой раньше миграции»: чтение деградирует, запись отказывает честно", async () => {
  const source = await readFile(modulePath, "utf8");

  // Тот же набор кодов, что и у whatsapp-channels: hosted PostgREST отвечает
  // PGRST205 из кэша схемы, 42P01/42703 — self-hosted путь.
  assert.ok(/NOT_PROVISIONED_CODES = new Set\(\["PGRST205", "42P01", "42703"\]\)/.test(source), "коды неприменённой таблицы");
  assert.ok(/schema cache/.test(source), "и текстовый признак кэша схемы");
  const gets = source.match(/available: false/g) || [];
  assert.ok(gets.length >= 3, "оба чтения и отсутствие арендатора отвечают available:false, а не пустотой-обманом");
  assert.ok(/migrations\/037_platform_recommendations\.sql/.test(source), "отказ записи называет миграцию по имени");
});

test("MR4 клиника меняет только свои строки и только статусы клиента", async () => {
  const source = await readFile(modulePath, "utf8");

  assert.ok(
    /\.eq\("workspace_id", workspaceId\)\s*\.eq\("id", id\)/.test(source),
    "PATCH фильтрует и по арендатору, и по строке — чужой id не меняется",
  );
  assert.ok(/CLINIC_STATUSES = new Set\(\["read", "done", "dismissed"\]\)/.test(source), "sent клиника поставить не может");
  assert.ok(/if \(status === "read"\) query = query\.eq\("status", "sent"\)/.test(source), "прочтение не затирает «сделана»");
  assert.ok(/query\.in\("status", \["sent", "read"\]\)/.test(source), "решение принимается один раз: done не переписывается на dismissed");
  // Идемпотентный повтор и чужой id отвечают одинаково — разница была бы
  // оракулом чужих идентификаторов.
  assert.ok(!/not_found/.test(source.slice(source.indexOf("handleWorkspaceRecommendations"))), "PATCH не различает «уже отмечена» и «чужой id»");
});

test("MR5 кнопка совета ведёт только внутрь продукта — с обеих сторон", () => {
  assert.equal(isInternalActionPath(""), true, "совет без кнопки допустим");
  assert.equal(isInternalActionPath("/staff-schedule"), true);
  assert.equal(isInternalActionPath("https://evil.example"), false);
  assert.equal(isInternalActionPath("//evil.example"), false, "protocol-relative обход закрыт");
  assert.equal(isInternalActionPath("/\\evil.example"), false, "обратный слэш — та же протокол-относительная форма");
  assert.equal(isInternalActionPath("javascript:alert(1)"), false);
  assert.equal(isInternalActionPath("staff-schedule"), false, "путь начинается со слэша");
});

test("MR5b длина совета ограничена на записи", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.ok(/content_too_long/.test(source), "переполнение — отдельный отказ, а не ошибка базы");
  assert.ok(/title: 200, body: 2000/.test(source), "пределы объявлены одним местом");
});

test("MR6 карточка в CRM: без права нет запроса, навигация только внутрь, отказ не роняет сводку", async () => {
  const source = await readFile(crmComponentPath, "utf8");

  assert.ok(/userRole === "owner" \|\| userRole === "admin" \|\| userRole === "manager"/.test(source), "советы видят те, кто может их выполнить");
  assert.ok(/if \(!canSee \|\| !isRealWorkspace\(\)\) return/.test(source), "без права и вне настоящего пространства запрос не уходит");
  assert.ok(/isInternalPath\(item\.actionPath\)/.test(source), "кнопка проверяет путь на месте, а не верит базе");
  assert.ok(/console\.warn\("\[recommendations\]/.test(source), "отказ уходит в консоль, а не на экран сводки");
  assert.ok(/status: "read"/.test(source) && /markedRead/.test(source), "прочтение отмечается фактом показа, один раз");
  // «Сделано»/«Скрыть»: сначала сервер, потом экран, и без двойного клика.
  assert.ok(/if \(!response\.ok\) return;\s*setItems/.test(source), "карточка исчезает только после подтверждения сервера");
  assert.ok(/if \(busyId\) return;/.test(source) && /disabled=\{busyId === item\.id\}/.test(source), "пока отметка едет, кнопки выключены");
});

test("MR7 портал: композер из сигнала и честная строка о неприменённой миграции", async () => {
  const source = await readFile(portalCardPath, "utf8");

  assert.ok(/SIGNAL_ACTIONS: Record<string, string>/.test(source), "сигнал знает, в какой раздел вести совет");
  assert.ok(/openComposer\(\{ title: text\.title, body: text\.why, signalKey: signal\.key \}\)/.test(source), "«Рекомендовать» предзаполняет композер из сигнала");
  assert.ok(/037_platform_recommendations\.sql/.test(source), "портал называет миграцию, пока таблицы нет");
  assert.ok(/recos\.available/.test(source), "и различает «таблицы нет» от «советов нет»");
  // Отказ чтения — своё состояние с повтором, а не вечное «Читаю…»: частично
  // применённая миграция (таблица без гранта) отвечает 502, и это видно.
  assert.ok(/"error" in recos/.test(source) && /Повторить/.test(source), "отказ чтения отличим и повторяем");
  assert.ok(/reco\.status === "read" \? reco\.readAt/.test(source), "даты прочтения и решения видны — «прочитана, но не сделана» заметно");
});
