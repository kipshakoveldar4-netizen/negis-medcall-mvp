import { pathToFileURL } from "node:url";
import path from "node:path";

// Провижининг НАСТОЯЩЕГО рабочего пространства — для передачи клиенту.
//
// Отличие от seed-clinic принципиальное: здесь не создаётся НИ ОДНОЙ выдуманной
// строки. Ни клиентов, ни заявок, ни записей, ни врачей. Это пространство
// настоящего салона или клиники, и первые данные в него внесут его сотрудники.
// Выдуманный пациент в настоящей CRM — это то, что потом всплывает в отчётах,
// рассылках и статистике, и вычистить его сложнее, чем не создать.
//
// Что создаётся, ровно четыре вещи:
//   1. Строка workspaces — само пространство.
//   2. Строка staff_users с ролью owner, привязанная к пользователю Supabase
//      Auth. БЕЗ этой привязки владелец не увидит ничего: сервер отвечает
//      отказом любому, у кого нет активного членства.
//   3. Настройка ниши (workspace_vertical) — салон или клиника: от неё зависят
//      подписи на экранах и правила проверки рекламы.
//   4. Настройка часового пояса (clinic_schedule) — без неё «сегодня» на
//      сводке считается неверно часть суток.
//
// Чего скрипт НЕ делает и не будет:
//   — не создаёт пользователей Auth и не трогает пароли. Пароль — секрет, и он
//     не должен проходить ни через этот скрипт, ни через чат. Пользователя
//     создаёт владелец платформы в панели Supabase (лучше через «Invite user»:
//     тогда салон сам задаёт себе пароль по ссылке из письма);
//   — не назначает подписку: тариф и цена назначаются в панели /platform;
//   — не приглашает сотрудников салона: это делает сам владелец салона из
//     продукта, через приглашения (у него роль owner — право есть).

const repoRoot = path.resolve(process.cwd(), process.cwd().endsWith("scripts") ? ".." : ".");

type Supabase = {
  from: (table: string) => {
    select: (columns: string, options?: Record<string, unknown>) => any;
    insert: (rows: unknown) => any;
  };
};

const { getSupabaseServerClient } = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
)) as { getSupabaseServerClient: () => Supabase | null };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : "";
}

const CONFIRM = "СОЗДАТЬ-РАБОЧЕЕ-ПРОСТРАНСТВО";

const name = arg("name");
const ownerEmail = arg("owner-email");
const ownerAuthId = arg("owner-auth-id");
const ownerName = arg("owner-name");
const timeZone = arg("timezone");
const vertical = arg("vertical");

if (arg("confirm") !== CONFIRM) {
  fail(
    [
      "Создаёт ПУСТОЕ рабочее пространство для настоящего клиента и привязывает",
      "к нему владельца. Никаких выдуманных данных не создаётся.",
      "",
      "Перед запуском создайте пользователя в Supabase → Authentication → Users.",
      "Надёжнее через «Invite user»: салон сам задаст себе пароль по ссылке из",
      "письма, и пароль не пройдёт ни через кого. Скопируйте UID пользователя.",
      "",
      "Запуск:",
      `  pnpm run provision:workspace -- --confirm=${CONFIRM} \\`,
      '    --name="Салон Люкс" --vertical=beauty \\',
      '    --owner-email=owner@salon.kz --owner-name="Имя Владельца" \\',
      "    --owner-auth-id=<UID пользователя Supabase Auth> --timezone=Asia/Almaty",
      "",
      "--vertical: beauty (салон красоты) или clinic (медицинская клиника).",
      "Умолчания нет намеренно: ниша меняет правила проверки рекламы, и выбрать",
      "её молча значило бы выбрать за клиента.",
    ].join("\n"),
  );
}

for (const [flag, value] of [
  ["name", name],
  ["owner-email", ownerEmail],
  ["owner-auth-id", ownerAuthId],
  ["owner-name", ownerName],
  ["timezone", timeZone],
  ["vertical", vertical],
] as const) {
  if (!value) fail(`Не задан --${flag}. Значения по умолчанию здесь не подставляются.`);
}

if (vertical !== "beauty" && vertical !== "clinic") {
  fail(`--vertical=${vertical} не распознан. Допустимо: beauty (салон) или clinic (клиника).`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID.test(ownerAuthId)) {
  fail("--owner-auth-id должен быть UID пользователя Supabase Auth (Authentication → Users → колонка UID).");
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) fail("--owner-email не похож на адрес почты.");
try {
  new Intl.DateTimeFormat("en-CA", { timeZone });
} catch {
  fail(`Часовой пояс «${timeZone}» не распознан. Пример: Asia/Almaty.`);
}

const supabase = getSupabaseServerClient();
if (!supabase) fail("Нет доступа к базе: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY.");

async function insertOne(table: string, row: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase!.from(table).insert([row]).select("*");
  if (error) fail(`${label}: ${error.message}`);
  const saved = Array.isArray(data) ? (data[0] as Record<string, unknown>) : null;
  if (!saved) fail(`${label}: база не вернула созданную строку.`);
  return saved;
}

async function main() {
  // Один и тот же пользователь Auth не должен оказаться владельцем двух
  // пространств по ошибке запуска дважды: скрипт не идемпотентен, и повторный
  // запуск создал бы вторую клинику с тем же владельцем. Проверяем и говорим.
  const { data: existing, error: lookupError } = await supabase!
    .from("staff_users")
    .select("workspace_id, role")
    .eq("auth_user_id", ownerAuthId);
  if (lookupError) fail(`Не удалось проверить существующие членства: ${lookupError.message}`);
  const allowSecond = arg("allow-second-membership") === "yes";
  if (!allowSecond && Array.isArray(existing) && existing.length > 0) {
    fail(
      [
        `У пользователя ${ownerAuthId} уже есть членство (${existing.length} шт.).`,
        "Если это повторный запуск — пространство уже создано, второе не нужно.",
        "Если нужен именно второй кабинет тому же человеку — скажите об этом",
        "прямо и запустите с --allow-second-membership=yes.",
      ].join("\n"),
    );
  }

  process.stdout.write(`Создаю пространство «${name}» (${vertical === "beauty" ? "салон красоты" : "клиника"})…\n`);

  const workspace = await insertOne("workspaces", { name, owner_email: ownerEmail }, "пространство");
  const workspaceId = String(workspace.id);
  if (!UUID.test(workspaceId)) fail("База не вернула идентификатор пространства.");

  await insertOne(
    "staff_users",
    {
      workspace_id: workspaceId,
      email: ownerEmail,
      full_name: ownerName,
      role: "owner",
      status: "active",
      auth_user_id: ownerAuthId,
    },
    "владелец",
  );

  await insertOne(
    "workspace_settings",
    { workspace_id: workspaceId, key: "workspace_vertical", value: { vertical } },
    "ниша",
  );
  await insertOne(
    "workspace_settings",
    { workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone } },
    "часовой пояс",
  );

  process.stdout.write(
    [
      "",
      "Готово. Пространство пустое — данных в нём нет, и это правильно:",
      `  пространство: ${workspaceId}`,
      `  владелец:     ${ownerEmail} (роль owner)`,
      `  ниша:         ${vertical === "beauty" ? "салон красоты" : "клиника"}`,
      `  пояс:         ${timeZone}`,
      "",
      "Дальше:",
      "  1. Если создавали пользователя через «Invite user» — салон уже получил",
      "     письмо и задаст пароль сам. Если с паролем — передайте его лично.",
      "  2. Назначьте тариф в панели /platform (кнопка «Назначить»).",
      "  3. Сотрудников салон приглашает сам: Настройки → Сотрудники →",
      "     пригласить по почте. Роль администратора салона — «Регистратор»:",
      "     она даёт прайс, мастеров и график, но не ключи интеграций.",
      "",
    ].join("\n"),
  );
}

await main();
