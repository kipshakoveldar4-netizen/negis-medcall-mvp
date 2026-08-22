import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Маршрут не должен спрашивать право, которого никто не выдаёт.
//
// ProtectedPage решает доступ строкой `!!rolePermissions[permission]`, а
// RolePermissions — это Record<string, boolean>. Значит опечатка в имени права
// и вовсе отсутствующий ключ для типов неотличимы от честного «нельзя»: сборка
// зелёная, тесты зелёные, а роль получает отказ на странице, ссылка на которую
// стоит у неё в меню.
//
// Так и случилось с /staff-schedule: маршрут спрашивал `directory`, в таблице
// ALL_PERMISSIONS такого ключа не было, и роль admin (в салоне — директор)
// упиралась в отказ. Владелец и управляющий проходят гейт по роли раньше
// таблицы, поэтому при проверке «своими глазами» всё выглядело рабочим.
//
// Проверка структурная: она ловит весь класс, а не один случай.

const here = path.dirname(fileURLToPath(import.meta.url));
const negisSrc = path.resolve(here, "../../artifacts/negis/src");

async function read(...parts: string[]): Promise<string> {
  return readFile(path.join(negisSrc, ...parts), "utf8");
}

test("RP1 каждое право, которое спрашивает маршрут, выдаётся хотя бы одной ролью", async () => {
  const app = await read("App.tsx");
  const auth = await read("contexts", "AuthContext.tsx");

  const asked = new Set([...app.matchAll(/permission="([a-z_]+)"/g)].map((match) => match[1]));
  assert.ok(asked.size >= 8, `маршруты спрашивают права: найдено ${asked.size}`);

  // Ключи полной таблицы: её получают владелец, управляющий и директор.
  const table = auth.slice(auth.indexOf("const ALL_PERMISSIONS"), auth.indexOf("const SYSTEM_ROLE_PERMISSIONS"));
  const granted = new Set([...table.matchAll(/^\s{2}([a-z_]+):\s*true,/gm)].map((match) => match[1]));

  for (const permission of asked) {
    assert.ok(granted.has(permission), `право «${permission}» спрашивает маршрут, но ALL_PERMISSIONS его не выдаёт`);
  }
});

test("RP2 право справочника считается по manage_directory, а не по админ-центру", async () => {
  const auth = await read("contexts", "AuthContext.tsx");
  // Смысл отдельного права: администратор салона правит прайс и смены, но
  // ключи интеграций и список сотрудников ему закрыты. Если справочник
  // однажды пересядет на view_admin, это перестанет быть правдой молча.
  assert.match(auth, /directory: crmPermissions\.has\('manage_directory'\)/);
  assert.ok(!/directory: crmPermissions\.has\('view_admin'\)/.test(auth), "справочник не должен зависеть от админ-центра");
});

test("RP3 ссылка в меню не ведёт туда, куда роли нельзя", async () => {
  const sidebar = await read("components", "layout", "Sidebar.tsx");
  // Пункт «Специалисты и график» показан администратору салона — значит и
  // маршрут обязан его пускать. Обратный случай (ссылка есть, доступа нет) —
  // это ровно то, на чём поймали directory.
  assert.match(sidebar, /\/staff-schedule[\s\S]{0,140}'receptionist'/);
});
