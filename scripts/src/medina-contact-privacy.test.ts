import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CP — мастер видит имя и время, но не контакты.
//
// Владелец: «мастера не должны видеть контактные данные клиентов, только имя и
// время записи без контактных данных. очень будь аккуратен».
//
// Карта утечки (три агента по коду) нашла ПЯТЬ независимых путей к телефону:
// список клиентов, обратный поиск «номер → карточка», список записей, эхо
// ответа на POST/PATCH записи и журнал изменений. Пины держат каждый.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const privacyPath = path.join(repoRoot, "lib", "crm", "contact-privacy.ts");

type PrivacyModule = {
  hidesClientContacts: (role: unknown) => boolean;
  maskContactsInText: (value: string) => string;
  redactContacts: <T extends Record<string, unknown>>(item: T, role: unknown) => T;
  redactContactsList: <T extends Record<string, unknown>>(items: T[], role: unknown) => T[];
  stripContactWrites: <T extends Record<string, unknown>>(row: T, role: unknown) => T;
};

const privacy = (await import(pathToFileURL(privacyPath).href)) as PrivacyModule;
const permissions = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "auth", "permissions.ts")).href
)) as { permissionsForRole: (role: string) => string[] };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("CP1 роль мастера теряет право на клиентов — а с ним обратный поиск и сделки", () => {
  const doctor = permissions.permissionsForRole("doctor");
  assert.ok(!doctor.includes("view_clients"), "список клиентов и поиск по номеру закрыты");
  assert.ok(!doctor.includes("manage_clients"));
  // Записи остаются: ради них мастеру и дают вход.
  assert.ok(doctor.includes("view_appointments") && doctor.includes("manage_appointments"));

  // Регистратор и владелец контакты видят — это их работа.
  assert.ok(permissions.permissionsForRole("receptionist").includes("view_clients"));
  assert.ok(permissions.permissionsForRole("owner").includes("view_clients"));
  assert.ok(!privacy.hidesClientContacts("receptionist"));
  assert.ok(!privacy.hidesClientContacts("owner"));
  assert.ok(privacy.hidesClientContacts("doctor"));
});

test("CP2 из записи уходят контакты, остаются имя, услуга и время", () => {
  const appointment = {
    id: "a1",
    client: "Айгуль",
    phone: "+7 701 234 56 78",
    whatsapp: "77012345678",
    service: "Маникюр",
    doctor: "Дильназ",
    startsAt: "2026-08-19T10:00:00Z",
    status: "scheduled",
    notes: "Аллергия на лак",
  };

  const forDoctor = privacy.redactContacts(appointment, "doctor");
  assert.equal(forDoctor.client, "Айгуль", "имя остаётся — по нему мастер узнаёт человека");
  assert.equal(forDoctor.startsAt, appointment.startsAt, "время остаётся");
  assert.equal(forDoctor.service, "Маникюр");
  assert.equal(forDoctor.notes, "Аллергия на лак", "рабочая заметка не выбрасывается целиком");
  assert.ok(!("phone" in forDoctor), "телефона нет");
  assert.ok(!("whatsapp" in forDoctor), "WhatsApp нет");

  // Регистратору отдаётся всё как было, и объект НЕ портится на месте.
  const forFrontDesk = privacy.redactContacts(appointment, "receptionist");
  assert.equal(forFrontDesk.phone, "+7 701 234 56 78");
  assert.equal(appointment.phone, "+7 701 234 56 78", "входной объект не мутируется");
});

test("CP3 номер, вписанный руками в свободный текст, маскируется", () => {
  // Регистратор пишет «перезвонить на +7…» в заметку — структурного поля тут
  // нет, и список запрещённых колонок такой номер не поймал бы.
  const masked = privacy.redactContacts(
    { id: "t1", title: "Перезвонить Марии +7 701 234 56 78", description: "почта maria@mail.ru", notes: "кабинет 12" },
    "doctor",
  );
  assert.ok(!/701/.test(String(masked.title)), `номер скрыт: ${masked.title}`);
  assert.ok(/Марии/.test(String(masked.title)), "имя в тексте остаётся");
  assert.ok(!/maria@mail\.ru/.test(String(masked.description)), "почта скрыта");
  // Решает КОЛИЧЕСТВО ЦИФР, а не длина строки. Первая версия маскировала любую
  // цепочку от семи символов с пробелами и дефисами — и съедала даты, суммы и
  // номер кабинета, то есть ровно то, ради чего заметку оставили читаемой.
  assert.equal(masked.notes, "кабинет 12");
  for (const keep of [
    "приём 40 минут, цена 15000",
    "перенос на 2026-08-19",
    "визит 12-05-2026, всё хорошо",
    "курс 1 200 000 тг",
    "кабинет 12",
  ]) {
    assert.equal(privacy.maskContactsInText(keep), keep, `не трогаем: ${keep}`);
  }

  // А номер ловится любым разделителем — точка тоже. Смена разделителя не
  // должна пробивать слой.
  for (const phone of ["звонить 701.234.56.78", "8 701 234-56-78", "+7(701)2345678", "87012345678"]) {
    assert.ok(!/\d{3}[.\-\s]?\d{2}[.\-\s]?\d{2}$/.test(privacy.maskContactsInText(phone)), `скрыт: ${phone} → ${privacy.maskContactsInText(phone)}`);
    assert.ok(/скрыт/.test(privacy.maskContactsInText(phone)), phone);
  }

  // Ник мессенджера — настоящий канал связи, и приходит он свободным текстом.
  assert.ok(!/masha_beauty/.test(privacy.maskContactsInText("только телеграм @masha_beauty")));

  // Метка времени остаётся меткой времени: цифры разбиты «T» и «:».
  assert.equal(privacy.maskContactsInText("2026-08-19T10:00:00Z"), "2026-08-19T10:00:00Z");
});

test("CP4 контакт нельзя не только прочитать, но и записать", () => {
  const row: Record<string, unknown> = { client_name: "Айгуль", client_phone: "+77012345678", whatsapp: "77012345678", status: "done" };
  const forDoctor = privacy.stripContactWrites(row, "doctor");
  assert.ok(!("client_phone" in forDoctor) && !("whatsapp" in forDoctor), "правка вслепую невозможна");
  assert.equal(forDoctor.status, "done", "статус мастер меняет — это его работа");
  assert.equal(forDoctor.client_name, "Айгуль");
  assert.equal(privacy.stripContactWrites(row, "receptionist").client_phone, "+77012345678");
});

test("CP5 срез стоит во ВСЕХ ветках ответа, а не только в списке", async () => {
  const server = stripComments(await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8"));

  // Пять путей из карты утечки: список, обратный поиск по номеру, эхо POST,
  // эхо PATCH и запись. Скрыть телефон только на экране значило бы отдать его
  // всякому, кто откроет консоль браузера.
  assert.ok(/redactContactsList\(\s*\(Array\.isArray\(data\)/.test(server), "список записей срезается");
  assert.ok(/redactContactsList\(\s*rows\.map\(/.test(server), "обратный поиск по номеру срезается");
  assert.equal((server.match(/redactContacts\(\s*config\.fromRow/g) ?? []).length, 2, "эхо POST и PATCH срезаются оба");
  // Каждый срез знает и КТО СМОТРИТ: с 043 телефон в своей записи мастеру
  // виден, а в чужой — нет, и без идентификатора смотрящего это не решить.
  assert.equal(
    (server.match(/staffUserId,/g) ?? []).length >= 4,
    true,
    "все четыре точки среза получают смотрящего",
  );

  assert.equal((server.match(/stripContactWrites\(/g) ?? []).length, 2, "запись контактов закрыта на создании и на правке");

  // Роль берётся из ПРОВЕРЕННОГО контекста, а не из запроса: иначе любой
  // назвался бы владельцем и получил телефоны.
  assert.ok(!/redactContacts\w*\([^)]*body\.role/.test(server), "роль не приходит из тела запроса");
  assert.ok(/readWorkspaceContext\(req\)\?\.role/.test(server));
});

test("CP6 карточка мастера прикрепляется к учётке, но только своя и только свободная", async () => {
  const source = stripComments(await readFile(path.join(repoRoot, "lib", "crm", "staff-credentials.ts"), "utf8"));

  const linkAt = source.indexOf('.from("clinic_doctors")');
  assert.ok(linkAt > 0, "привязка есть");
  const linkBlock = source.slice(linkAt, linkAt + 1200);

  // Три условия, каждое закрывает свой промах: точное имя (иначе чужой график
  // достанется не тому), свободная карточка (иначе отберём у коллеги), активная
  // (у архивной имя могло освободиться).
  assert.ok(/\.eq\("workspace_id", context\.workspaceId\)/.test(linkBlock), "только своя клиника");
  assert.ok(/\.eq\("is_active", true\)/.test(linkBlock), "только активная карточка");
  assert.ok(/\.is\("staff_user_id", null\)/.test(linkBlock), "только не привязанная");
  assert.ok(/ilike\("full_name", escapeLikePattern\(/.test(linkBlock), "имя сравнивается значением, а не шаблоном");
  // Гонка: карточку могли привязать между чтением и записью.
  assert.equal((linkBlock.match(/\.is\("staff_user_id", null\)/g) ?? []).length, 2, "условие стоит и в чтении, и в записи");
  // Провал привязки не отменяет заведения: вход важнее связи.
  assert.ok(!/if \(!linked\) return/.test(linkBlock), "неудачная привязка не ломает создание сотрудника");
  assert.ok(/linkedDoctor/.test(source), "и экран узнаёт о привязке из ответа");
});

test("CP7 журнал изменений не отдаёт мастеру даже маску телефона", async () => {
  const log = stripComments(await readFile(path.join(repoRoot, "lib", "crm", "change-log.ts"), "utf8"));

  // Шестой путь, и самый незаметный: телефон лежит в журнале «маской» —
  // последними четырьмя цифрами, — а перебрать записи своего расписания мастер
  // может по их id. Четыре цифры это всё ещё контакт.
  assert.ok(/hidesClientContacts\(context\.role\)/.test(log), "срез по роли из проверенного контекста");
  assert.ok(/CONTACT_FIELD_NAMES/.test(log), "контактные поля журнала названы списком");
  assert.ok(/client_phone/.test(log) && /whatsapp/.test(log), "и телефон, и WhatsApp в этом списке");
});

test("CP8 контакт нельзя прислать: отказ явный, а не молчаливое выбрасывание", async () => {
  const server = stripComments(await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8"));

  // Молча выбросить поле значило бы сказать «сохранено» человеку, чей ввод
  // исчез: мастер вводит телефон, видит «Запись создана», а регистратор потом
  // не может дозвониться.
  assert.equal((server.match(/hasContactFields\(/g) ?? []).length, 3, "проверка на создании и на правке плюс объявление");
  assert.ok(/Контакты клиента недоступны вашей роли/.test(server), "отказ говорит словами");

  // И экран мастера этого поля не показывает вовсе.
  const page = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8"));
  assert.ok(/userRole !== "doctor" &&/.test(page), "поле «Телефон» скрыто от мастера");
  assert.ok(/!contactsHidden && !form\.phone\.trim\(\)/.test(page), "и не требуется при сохранении");
});

test("CP9 кэш списков не переживает смену пользователя во вкладке", async () => {
  const storage = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "lib", "demoStorage.ts"), "utf8"));
  const auth = stripComments(await readFile(path.join(repoRoot, "artifacts", "negis", "src", "contexts", "AuthContext.tsx"), "utf8"));

  // Ключ кэша — «эндпоинт + клиника», без пользователя. На общей машине
  // ресепшена мастер, вошедший следом за регистратором, первую минуту видел бы
  // её строки с телефонами — до того как придёт срезанный ответ сервера.
  assert.ok(/export function clearListReadCache/.test(storage), "кэш умеет очищаться");
  const signOutAt = auth.indexOf("const signOut");
  const signOutBody = auth.slice(signOutAt, signOutAt + 900);
  assert.ok(/clearListReadCache\(\)/.test(signOutBody), "и очищается при выходе");
  assert.ok(/clearCrmCache\(\)/.test(signOutBody), "рядом с общим кэшем запросов");
});

/* ── Свой клиент против клиента клиники (правило владельца от 21.08.2026) ── */

test("CP10 телефон в записи, которую завёл сам мастер, ему виден", async () => {
  // «Мастера могут записывать своих клиентов и видеть их номера». Прятать от
  // мастера номер, который он же и вписал, — это не приватность, а помеха.
  const privacy = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "contact-privacy.ts")).href
  )) as {
    redactContacts: (item: Record<string, unknown>, role: unknown, actor?: unknown) => Record<string, unknown>;
  };
  const mine = privacy.redactContacts(
    { client: "Мария", phone: "+7 701 245 18 44", createdByStaffUserId: "staff-1" },
    "doctor",
    "staff-1",
  );
  assert.equal(mine.phone, "+7 701 245 18 44");
});

test("CP11 телефон в записи, которую завёл админ, мастеру не виден", async () => {
  const privacy = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "contact-privacy.ts")).href
  )) as {
    redactContacts: (item: Record<string, unknown>, role: unknown, actor?: unknown) => Record<string, unknown>;
  };
  const theirs = privacy.redactContacts(
    { client: "Мария", phone: "+7 701 245 18 44", createdByStaffUserId: "staff-admin" },
    "doctor",
    "staff-1",
  );
  assert.ok(!("phone" in theirs), "номер чужой записи остался у мастера");
  assert.equal(theirs.client, "Мария", "имя и время мастеру по-прежнему нужны");
});

test("CP12 запись без автора — как чужая: истории до 043 телефоны не открываем", async () => {
  const privacy = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "contact-privacy.ts")).href
  )) as {
    redactContacts: (item: Record<string, unknown>, role: unknown, actor?: unknown) => Record<string, unknown>;
  };
  const legacy = privacy.redactContacts({ client: "Мария", phone: "+7 701 245 18 44" }, "doctor", "staff-1");
  assert.ok(!("phone" in legacy), "«не знаю автора» трактуется как «не свой»");
});

test("CP13 владелец и админ видят номера всегда", async () => {
  const privacy = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "contact-privacy.ts")).href
  )) as {
    redactContacts: (item: Record<string, unknown>, role: unknown, actor?: unknown) => Record<string, unknown>;
  };
  for (const role of ["owner", "admin", "receptionist"]) {
    const item = privacy.redactContacts(
      { client: "Мария", phone: "+7 701 245 18 44", createdByStaffUserId: "staff-admin" },
      role,
      "staff-9",
    );
    assert.equal(item.phone, "+7 701 245 18 44", role);
  }
});

test("CP14 автор записи ставится из проверенного контекста, а не из тела", async () => {
  // Иначе вызывающий переписал бы правило видимости телефона за нас: прислал
  // чужой идентификатор автора — и получил доступ к номеру чужого клиента.
  const source = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const anchor = "row.created_by_staff_user_id = actorStaffUserId";
  assert.ok(source.includes(anchor), "автор проставляется сервером");
  const before = source.slice(Math.max(0, source.indexOf(anchor) - 220), source.indexOf(anchor));
  assert.ok(before.includes("readWorkspaceContext(req)?.staffUserId"), "и берётся из контекста запроса");
  assert.ok(!before.includes("body."), "а не из тела запроса");
});
