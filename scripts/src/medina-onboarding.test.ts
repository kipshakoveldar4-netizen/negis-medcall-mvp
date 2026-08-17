import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// MB — подключение клиники с портала Medina Control.
//
// Форма заменяет provision-скрипт, но не его принципы: ни одной выдуманной
// строки, ниша без умолчания, пароль не проходит нигде. Набор закрепляет
// ровно эти принципы плюс честность полусозданного состояния.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "platform-onboarding.ts");
const controlSrc = path.join(repoRoot, "artifacts", "medina-control", "src");

type OnboardingModule = {
  validateOnboardingRequest: (body: Record<string, unknown>) =>
    | { name: string; vertical: string; ownerEmail: string; ownerName: string; timeZone: string }
    | { status: number; error: string; code: string; details?: string[] };
};

const { validateOnboardingRequest } = (await import(pathToFileURL(modulePath).href)) as OnboardingModule;

const VALID = {
  name: "Салон Люкс",
  vertical: "beauty",
  ownerEmail: "Owner@Salon.kz",
  ownerName: "Имя Владельца",
  timeZone: "Asia/Almaty",
};

test("MB1 ниша обязательна и умолчания у неё нет", () => {
  const missing = validateOnboardingRequest({ ...VALID, vertical: "" });
  assert.ok("status" in missing && missing.status === 400, "без ниши — отказ");

  const wrong = validateOnboardingRequest({ ...VALID, vertical: "salon" });
  assert.ok("status" in wrong, "выдуманная ниша — отказ, а не подстановка клиники");

  const ok = validateOnboardingRequest(VALID);
  assert.ok(!("status" in ok));
  assert.equal(ok.vertical, "beauty");
  assert.equal(ok.ownerEmail, "owner@salon.kz", "почта нормализуется");
});

test("MB2 часовой пояс проверяется, имя подставляется из почты", () => {
  const badZone = validateOnboardingRequest({ ...VALID, timeZone: "Asia/Nowhere" });
  assert.ok("status" in badZone, "нераспознанный пояс — отказ");

  const noZone = validateOnboardingRequest({ ...VALID, timeZone: "" });
  assert.ok("status" in noZone, "пояс обязателен");

  const noName = validateOnboardingRequest({ ...VALID, ownerName: "" });
  assert.ok(!("status" in noName));
  assert.equal(noName.ownerName, "owner@salon.kz", "пустое имя — почта, а не выдумка");
});

test("MB3 пароль не проходит через подключение нигде", async () => {
  const server = await readFile(modulePath, "utf8");
  for (const word of ["password", "createUser", "auth.admin"]) {
    assert.ok(!server.toLowerCase().includes(word.toLowerCase()), `сервер: нет ${word}`);
  }
  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(!/password/i.test(form), "форма портала пароль не спрашивает");
  assert.ok(form.includes("/join"), "и объясняет путь через страницу приглашения");
});

test("MB4 приглашение владельца — той же машинерией, что у сотрудников", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.ok(/createInvitationToken\(\)/.test(source), "токен из общего модуля");
  assert.ok(/token_hash: tokenHash/.test(source), "в базе только хэш");
  assert.ok(/role: "owner"/.test(source), "роль — владелец нового пространства");
  assert.ok(/invited_by_staff_user_id: null/.test(source), "приглашает платформа, а не сотрудник");
  assert.ok(/sendSupabaseInviteEmail\(/.test(source), "письмо — best effort тем же путём");
});

test("MB5 полусозданное состояние называется, а не угадывается", async () => {
  const source = await readFile(modulePath, "utf8");
  const partials = source.match(/partial_onboarding/g) || [];
  assert.equal(partials.length, 2, "оба поздних отказа помечены");
  assert.ok(/Пространство \$\{workspaceId\}/.test(source), "и называют созданное пространство по id");
});

test("MB6 живое приглашение той же почты не даёт создать второе пространство", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.ok(/invitation_already_pending/.test(source), "повтор — явный отказ");
  assert.ok(/\.gt\("expires_at"/.test(source), "истёкшие приглашения не блокируют");
  assert.ok(/\.is\("accepted_at", null\)/.test(source) && /\.is\("revoked_at", null\)/.test(source), "принятые и отозванные — тоже");
});

test("MB7 маршрут платформенный и только POST", async () => {
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-onboarding": \{ kind: "platform", methods: \["POST"\] \}/.test(registry));
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-onboarding":\s*return handlePlatformOnboarding\(req, res\);/.test(router));
});

test("MB9 живое приглашение — не тупик: перевыпуск отзывает старое и выписывает новое", async () => {
  const source = await readFile(modulePath, "utf8");
  const reissue = source.slice(
    source.indexOf("export async function handlePlatformInvitationReissue"),
    source.indexOf("export async function handlePlatformOnboarding"),
  );
  assert.ok(reissue.length > 0, "обработчик перевыпуска существует");
  // Сначала отзыв, потом новая ссылка: два живых токена на одну почту — это
  // два пути в одно пространство, и потерянный никто бы не отозвал.
  assert.ok(
    reissue.indexOf("revoked_at: now") < reissue.indexOf("createInvitationToken()"),
    "старые приглашения отзываются до выписки нового",
  );
  assert.ok(/owner_already_member/.test(reissue), "принявшего владельца не приглашают второй раз");

  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");
  assert.ok(/"platform-invitation-reissue": \{ kind: "platform", methods: \["POST"\] \}/.test(registry));
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  assert.ok(/case "platform-invitation-reissue":\s*return handlePlatformInvitationReissue\(req, res\);/.test(router));

  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/invitation_already_pending/.test(form) && /Перевыпустить приглашение/.test(form), "409 формы предлагает перевыпуск на месте");
});

test("MB8 портал показывает ссылку один раз и не выбирает нишу молча", async () => {
  const form = await readFile(path.join(controlSrc, "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/<option value="">/.test(form), "первый пункт ниши пуст — выбор обязателен");
  assert.ok(/result\.acceptUrl/.test(form), "ссылка отдаётся владельцу платформы");
  assert.ok(/показывается один раз/i.test(form), "и портал говорит, что второй раз её не покажут");
  const app = await readFile(path.join(controlSrc, "App.tsx"), "utf8");
  assert.ok(app.includes("Подключить клинику"), "пункт меню ведёт к работающей форме");
});
