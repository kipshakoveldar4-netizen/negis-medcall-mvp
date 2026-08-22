import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// База клиентов по мастерам: «чей это клиент».
//
// Правило владельца: мастер видит свою часть базы без номеров, администратор —
// базу всех мастеров с номерами. Опасность здесь не в том, что экран сломается,
// а в том, что он тихо покажет лишнее: список с номерами уходит из салона одним
// снимком экрана, и заметить это постфактум нельзя.
//
// Проверки структурные — они держат сами гарантии маршрута, а не вёрстку.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function read(...parts: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...parts), "utf8");
}

test("MC1 маршрут объявлен в реестре и подключён к единственному входу", async () => {
  const registry = await read("lib", "crm", "authorization.ts");
  const router = await read("api", "crm", "[...path].ts");

  assert.match(registry, /"my-clients": \{ kind: "browser", methods: \["GET"\] \}/);
  assert.ok(router.includes('case "my-clients":'), "маршрут должен раздаваться из общего catch-all");
  assert.ok(
    router.includes('import { handleMyClients } from "../../lib/crm/my-clients"'),
    "новых файлов в api/ не заводим: лимит функций Vercel",
  );
});

test("MC2 без права не отдаём ничего", async () => {
  const source = await read("lib", "crm", "my-clients.ts");
  // Ни одна роль не проходит по умолчанию: нужно либо право на клиентов, либо
  // право на записи — второе и есть «мастер».
  assert.match(source, /const seesEveryone = permissions\.includes\("view_clients"\)/);
  assert.match(source, /const seesOwnOnly = permissions\.includes\("view_appointments"\)/);
  assert.match(source, /if \(!context \|\| \(!seesEveryone && !seesOwnOnly\)\)[\s\S]{0,120}403/);
});

test("MC3 мастер не может спросить про чужую базу", async () => {
  const source = await read("lib", "crm", "my-clients.ts");
  // doctorId из запроса читается ТОЛЬКО в ветке администратора. Если однажды
  // фильтр вынесут наверх «чтобы не дублировать», мастер сможет подставить
  // чужой идентификатор и получить чужую базу — сервер ему поверит.
  const adminBranch = source.slice(source.indexOf("if (seesEveryone) {"), source.indexOf("} else {"));
  assert.ok(adminBranch.includes("requestedDoctorId"), "фильтр по мастеру — привилегия администратора");

  const masterBranch = source.slice(source.indexOf("} else {"), source.indexOf("const links ="));
  assert.ok(!masterBranch.includes("requestedDoctorId"), "мастеру идентификатор из запроса не подставляется");
  assert.ok(
    masterBranch.includes("readOwnWorkIdentity") && masterBranch.includes("identity.doctorId"),
    "мастер сужается собственной карточкой, а не параметром",
  );
});

test("MC4 контакты режутся тем же слоем, что и везде", async () => {
  const source = await read("lib", "crm", "my-clients.ts");
  assert.match(source, /redactContactsList\(\s*items as unknown as Record<string, unknown>\[\],\s*role,?\s*\)/);
  // Исключения «своя запись» здесь быть не должно: в записях оно осмысленно,
  // в выгрузке базы — это дыра.
  assert.ok(
    !source.includes("keepsContactsForOwnRecord"),
    "список базы не знает исключений: иначе мастер выгрузит номера своих клиентов",
  );
  assert.match(source, /contactsHidden: hidesClientContacts\(role\)/, "экран обязан знать, что номера скрыты");
});

test("MC5 пустой ответ никогда не выдаётся за пустую базу", async () => {
  const source = await read("lib", "crm", "my-clients.ts");
  // Три разных «пусто», и каждое названо своим словом.
  assert.match(source, /identity\.readFailed[\s\S]{0,300}503/, "сбой чтения личности — честный отказ");
  assert.match(source, /reason: "unlinked"/, "карточка без входа названа прямо");
  assert.match(source, /available: false,\s*migration: "042"/, "невключённая миграция названа номером");
  assert.match(source, /502[\s\S]{0,80}read_failed/, "отказ базы не притворяется пустотой");
});

test("MC6 обрезка выдачи не молчит", async () => {
  const source = await read("lib", "crm", "my-clients.ts");
  // Молчаливый предел читается как «это вся база»: клиент, не попавший в
  // выдачу, считается несуществующим, и его заводят заново.
  assert.match(source, /const truncated = new Set\(links\.rows\.map\(\(row\) => row\.clientId\)\)\.size > clientIds\.length/);
  assert.match(source, /truncated,\s*limit: MY_CLIENTS_LIMIT/);
});

test("MC7 экран есть на обеих поверхностях навигации и открыт мастеру", async () => {
  const app = await read("artifacts", "negis", "src", "App.tsx");
  const sidebar = await read("artifacts", "negis", "src", "components", "layout", "Sidebar.tsx");
  const mobile = await read("artifacts", "negis", "src", "components", "layout", "MobileNav.tsx");

  // Право booking, а не crm: crm мастеру закрыт намеренно — оно открывает
  // списки всей клиники. Если страницу однажды пересадят на crm, мастер
  // потеряет свою базу, а сообщения об этом не будет.
  assert.match(app, /path="\/client-base"[\s\S]{0,140}permission="booking"/);
  assert.match(sidebar, /\/client-base[\s\S]{0,200}'doctor'/, "мастер обязан видеть пункт в меню");
  // Мастера работают с телефона: без пункта в мобильном ящике страница для них
  // существует только по прямому адресу.
  assert.match(mobile, /"\/client-base"[\s\S]{0,120}permission: "booking"/);
});

test("MC8 страница не рисует колонку телефона, когда сервер их срезал", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "ClientBasePage.tsx");
  // Признак приходит от сервера, а не вычисляется из роли на клиенте: роль в
  // браузере — подсказка интерфейса, а не источник правды.
  assert.match(page, /contactsHidden: Boolean\(payload\.contactsHidden\)/);
  assert.match(page, /state\.contactsHidden \? null : <th[^>]*>Телефон<\/th>/);
  assert.ok(page.includes("Номера скрыты: их видят владелец и администраторы."), "молчаливое отсутствие колонки читается как потеря данных");
  // Обрезка выдачи обязана быть видна человеку.
  assert.ok(page.includes("Показаны не все"), "молчаливый предел читается как «это вся база»");
  assert.ok(page.includes("Это сбой связи, а не пустая база"), "отказ не притворяется пустотой");
});
