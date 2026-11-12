import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AL — живой запуск рекламы решается ролью из базы, а не из тела запроса.
//
// Инвариант репозитория: «ACTIVE launch must remain gated». Держали его два
// замка, и оба открывались тем же, кто их проверял.
//
// Первый: `const actorRole = firstString(body.launchedByRole, body.actorRole,
// "owner")`. Роль называл сам вызывающий, а умолчанием был владелец. Маршрут
// meta-launch требует право manage_marketing, и оно есть у маркетолога — не
// владельца и не администратора. Один POST со своим настоящим токеном и
// `"launchedByRole": "owner"` в теле снимал оба потолка бюджета и запускал
// живую кампанию за деньги клиники, а в журнал попадала роль «owner».
//
// Второй: readMetaLiveLaunchEnabled при отсутствии сохранённой настройки и при
// любой ошибке чтения возвращала `body.liveLaunchEnabled`. Клиника, ни разу не
// трогавшая переключатель, строки настройки не имеет по определению — то есть
// у всех новых клиник замок был открыт сразу.
//
// Проверки ниже читают исходник: путь запуска ходит в Meta, и поднимать его в
// наборе нельзя. Ничего здесь не обращается ни к Meta, ни к production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const permissionsPath = path.join(repoRoot, "lib", "auth", "permissions.ts");
const authorizationPath = path.join(repoRoot, "lib", "crm", "authorization.ts");

async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

test("AL1 роль запуска берётся из проверенного контекста, а не из тела", async () => {
  const code = await codeOf(serverPath);

  assert.ok(
    !/actorRole = firstString\(body\.launchedByRole/.test(code),
    "роль, названную отправителем, нельзя пускать в гейт живого запуска",
  );
  assert.ok(
    /const actorRole = readWorkspaceContext\(req\)\?\.role/.test(code),
    "роль выводится из членства по проверенному токену",
  );
  // Умолчания «owner» в ПРИСВАИВАНИИ быть не должно: нет контекста — нет роли.
  // Проверка именно на присваивание, а не на любое соседство со словом owner:
  // строкой `actorRole !== "owner"` пользуется назначение ролей сотрудникам,
  // и это другая функция и другой смысл.
  // Присваиваний два и оба законны: одно в назначении ролей сотрудникам
  // (context.role), одно здесь. Требование ко всем одинаковое.
  const assignments = code.match(/const actorRole\s*=\s*[^\n]+/g) || [];
  assert.ok(assignments.length > 0, "присваивание найдено");
  for (const assignment of assignments) {
    assert.ok(!assignment.includes('"owner"'), `владелец не подставляется по умолчанию: ${assignment}`);
    assert.ok(!assignment.includes("body."), `тело запроса не участвует: ${assignment}`);
    assert.ok(/context|readWorkspaceContext/.test(assignment), `роль берётся из контекста: ${assignment}`);
  }
});

test("AL2 разрешение на живой запуск не читается из тела запроса", async () => {
  const code = await codeOf(serverPath);

  const start = code.indexOf("async function readMetaLiveLaunchEnabled");
  assert.ok(start > 0, "функция на месте");
  const body = code.slice(start, code.indexOf("\n}", start));

  assert.ok(!body.includes("body."), "тело запроса здесь не источник разрешения");
  assert.ok(!/liveLaunchEnabled\b/.test(body.replace("readMetaLiveLaunchEnabled", "")), "и его поля тоже");
  assert.ok(/return false;/.test(body), "умолчание — отказ");

  // Сбой чтения означает «не знаю, разрешено ли». Для живой рекламы за чужие
  // деньги «не знаю» — это «нет».
  const tail = body.slice(body.indexOf("catch"));
  assert.ok(/return false;/.test(tail) || /catch[\s\S]*\n\s*\}\s*\n\s*return false;/.test(body), "и при ошибке тоже отказ");
});

test("AL3 право на маршрут запуска есть у роли, которая живую кампанию включать не вправе", async () => {
  const permissions = await codeOf(permissionsPath);
  const authorization = await codeOf(authorizationPath);

  // Ровно это расхождение и делало дефект достижимым: маршрут открыт по
  // manage_marketing, а решение о ACTIVE — по owner/admin.
  assert.ok(/"meta-launch":[\s\S]{0,240}manage_marketing/.test(authorization), "маршрут открыт по manage_marketing");
  assert.ok(/marketer:[\s\S]{0,400}manage_marketing/.test(permissions), "и это право есть у маркетолога");
  assert.ok(
    /workspaceAdminRoles[^\n]*=\s*\["owner", "admin"\]/.test(permissions),
    "а высшая инстанция в клинике — только владелец и администратор",
  );
});

test("AL4 сам гейт ACTIVE и потолки бюджета на месте", async () => {
  const code = await codeOf(serverPath);

  assert.ok(/roleCanLaunchActive\(role: string\)/.test(code), "проверка роли существует");
  assert.ok(/\["owner", "admin"\]\.includes\(role/.test(code), "и пускает только владельца и администратора");
  assert.ok(/ACTIVE запуск доступен только owner\/admin/.test(code), "отказ по роли на месте");
  assert.ok(/ACTIVE запуск выключен в Admin Center/.test(code), "отказ по настройке на месте");
  assert.ok(/META_MAX_DAILY_BUDGET/.test(code) && /META_MAX_TOTAL_BUDGET/.test(code), "потолки бюджета на месте");
});

test("AL5 в журнал запуска уходит проверенная роль", async () => {
  const code = await codeOf(serverPath);

  // Пока роль приходила из тела, журнал фиксировал «owner» для любого, кто это
  // слово написал. Аудит, которому нельзя верить, хуже отсутствующего.
  assert.ok(/launchedByRole: actorRole/.test(code), "в записи запуска — та же величина");
  assert.ok(
    /const actorRole = readWorkspaceContext\(req\)\?\.role/.test(code),
    "и она выведена из проверенного членства",
  );
});
