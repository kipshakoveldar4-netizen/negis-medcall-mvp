import { pathToFileURL } from "node:url";
import path from "node:path";

// Наполнение отдельной клиники — чтобы CRM было видно с данными.
//
// Замысел один и он определяет всё остальное: данные ложатся НАСТОЯЩИМИ
// строками настоящих таблиц. Тогда на экране нет неправды — счётчики честно
// считают то, что действительно лежит в базе, и оговаривать нечего. Подставлять
// числа в интерфейс этот скрипт не умеет и уметь не должен.
//
// Что здесь сделано осознанно, а не по недосмотру:
//
// ТЕЛЕФОНЫ. Только шаблон +7 700 000 XX XX, и у каждой сущности свой диапазон.
// Правдоподобный казахстанский номер в медицинской CRM — это чужой человек,
// которому позвонят или напишут с предпоказа от имени клиники.
//
// ВЫХОДНЫЕ. Записи не ставятся в дни, которые этот же скрипт объявил
// нерабочими: экран печатает врачу «Вс: выходной» и тут же под этой строкой
// показывает его визиты, а любой их перенос упирается в отказ сервера.
//
// ЗАМЕТКИ. Только административные: «просит напомнить за час», «первичный
// визит». Ни диагнозов, ни жалоб, ни назначений. Выдуманная клиническая деталь
// про выдуманного человека — это всё равно выдуманная медицинская запись, и на
// предпоказе её увидят посторонние.
//
// ГЕНЕРИРУЕМЫЕ КОЛОНКИ. phone_normalized и whatsapp_normalized не
// перечисляются нигде: их считает база, и явная запись отвергается.
//
// ТАКСОНОМИЯ. Этапы и источники заявок не вставляются: их создаёт триггер на
// вставку рабочего пространства. Ручная вставка тех же ключей упадёт, а других
// ключей — даст второй комплект и восемь колонок на доске вместо четырёх.
//
// ГРАНИЦА АРЕНДАТОРА. Каждая строка получает workspace_id, и каждая ссылка
// указывает на строку того же пространства. Внешние ключи этого не требуют —
// они смотрят на id, а не на workspace_id, — поэтому проверка тут на скрипте.
//
// ПЕРЕСЕЧЕНИЯ. Записи одного врача не накладываются. Проверка пересечений в
// продукте сравнивает имена врачей строками: посаженный внахлёст приём
// продолжит показываться, но любая его правка на предпоказе вернёт отказ.

const repoRoot = path.resolve(process.cwd(), process.cwd().endsWith("scripts") ? ".." : ".");

type Supabase = {
  from: (table: string) => {
    select: (columns: string, options?: Record<string, unknown>) => any;
    insert: (rows: unknown) => any;
    update: (patch: unknown) => any;
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

const CONFIRM = "СОЗДАТЬ-НОВУЮ-КЛИНИКУ";

/**
 * Телефон, про который видно, что он вымышлен.
 *
 * Номер собирается из четырёх цифр, а не из двух, и каждая сущность получает
 * свой диапазон. Двух цифр не хватало: 42 клиента и 58 заявок заворачивались по
 * модулю сотни, и восемь заявок получали номер чужого пациента. На предпоказе
 * это значит, что «Создать клиента» из такой заявки молча привязывает её к
 * карточке другого человека и показывает зелёный тост об успехе.
 */
function phone(range: "staff" | "client" | "lead", index: number): string {
  const base = { staff: 0, client: 1000, lead: 5000 }[range] + index;
  const digits = String(base).padStart(4, "0");
  return `+7 700 000 ${digits.slice(0, 2)} ${digits.slice(2)}`;
}

/** Часовой пояс задаёт владелец: придумывать его нельзя. */
const timeZone = arg("timezone");
const clinicName = arg("name");
const ownerEmail = arg("owner-email");
const ownerAuthId = arg("owner-auth-id");

if (arg("confirm") !== CONFIRM) {
  fail(
    [
      "Скрипт создаёт НОВУЮ клинику и наполняет её данными. Это необратимо:",
      "маршрутизатор CRM не принимает DELETE ни для одного ресурса, поэтому",
      "убрать посаженное можно будет только SQL-ом, руками, по одной таблице.",
      "",
      "Запуск:",
      `  pnpm run seed:clinic -- --confirm=${CONFIRM} \\`,
      '    --name="Клиника на Абая" --owner-email=you@example.com \\',
      "    --owner-auth-id=<id пользователя Supabase Auth> --timezone=Asia/Almaty",
      "",
      "Никогда не запускайте это против базы, где работают настоящие клиники,",
      "если не уверены: одна ошибка в workspace_id — вымышленный пациент в чужой",
      "медицинской карточке.",
    ].join("\n"),
  );
}

for (const [flag, value] of [
  ["name", clinicName],
  ["owner-email", ownerEmail],
  ["owner-auth-id", ownerAuthId],
  ["timezone", timeZone],
] as const) {
  if (!value) fail(`Не задан --${flag}. Значения по умолчанию здесь не подставляются.`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID.test(ownerAuthId)) fail("--owner-auth-id должен быть идентификатором пользователя Supabase Auth.");
try {
  new Intl.DateTimeFormat("en-CA", { timeZone });
} catch {
  fail(`Часовой пояс «${timeZone}» не распознан.`);
}

const supabase = getSupabaseServerClient();
if (!supabase) fail("Нет доступа к базе: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY.");

/** День клиники — тот же приём, что и на сервере: через Intl, а не getHours. */
function clinicDayStart(offsetDays: number): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
  const base = new Date(Date.UTC(pick("year"), pick("month") - 1, pick("day")));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base;
}

/**
 * Смещение пояса клиники относительно UTC в заданное мгновение.
 *
 * Через formatToParts, а не через toLocaleString: прежний вариант сравнивал
 * дату, разобранную в поясе МАШИНЫ, с исходной, поэтому у владельца, чей
 * ноутбук стоит в поясе клиники, смещение выходило нулевым — и все записи
 * уезжали на пять часов. Ошибка обратная той, ради которой всё это писалось:
 * скрипт, наполняющий базу для проверки суток клиники, сам считал по машине.
 */
function zoneOffsetMinutes(instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour") % 24, pick("minute"), pick("second"));
  return Math.round((asUtc - instantMs) / 60000);
}

/** Мгновение для записи: день клиники плюс часы и минуты по её же часам. */
function at(offsetDays: number, hour: number, minute: number): string {
  const day = clinicDayStart(offsetDays);
  const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0);
  // Два прохода: первый даёт смещение около нужного мгновения, второй
  // поправляет его в сутках, где происходит переход на летнее время.
  const first = guess - zoneOffsetMinutes(guess) * 60000;
  return new Date(guess - zoneOffsetMinutes(first) * 60000).toISOString();
}

/** День недели в поясе клиники: 1 — понедельник, 7 — воскресенье. */
function clinicWeekday(offsetDays: number): number {
  const day = clinicDayStart(offsetDays);
  const weekday = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

async function insert<T>(table: string, rows: T[], label: string): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase!.from(table).insert(rows).select("*");
  if (error) fail(`${label}: ${error.message}`);
  return (data || []) as Array<Record<string, unknown>>;
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length];
}

async function main() {
  process.stdout.write(`Создаю клинику «${clinicName}» в поясе ${timeZone}…\n`);

  const [workspace] = await insert("workspaces", [{ name: clinicName, owner_email: ownerEmail }], "клиника");
  const workspaceId = String(workspace.id);
  if (!UUID.test(workspaceId)) fail("База не вернула идентификатор новой клиники.");
  process.stdout.write(`  клиника: ${workspaceId}\n`);

  await insert(
    "workspace_settings",
    [{ workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone } }],
    "настройки",
  );

  // Владелец — единственный, кому нужен auth_user_id: без совпадения с
  // пользователем Supabase Auth сервер ответит отказом и экраны будут пусты.
  const staff = await insert(
    "staff_users",
    [
      { workspace_id: workspaceId, email: ownerEmail, full_name: "Владелец клиники", role: "owner", status: "active", auth_user_id: ownerAuthId, phone: phone("staff", 1) },
      { workspace_id: workspaceId, email: `reception@${ownerEmail.split("@")[1]}`, full_name: "Асель Ким", role: "receptionist", status: "active", phone: phone("staff", 2) },
      { workspace_id: workspaceId, email: `marketing@${ownerEmail.split("@")[1]}`, full_name: "Тимур Ли", role: "marketer", status: "active", phone: phone("staff", 3) },
    ],
    "сотрудники",
  );
  const owner = staff[0];
  const reception = staff[1];

  const services = await insert(
    "clinic_services",
    [
      { workspace_id: workspaceId, name: "Консультация косметолога", category: "Консультации", base_price_minor: 500_000, duration_minutes: 30, sort_order: 1, is_active: true },
      { workspace_id: workspaceId, name: "Чистка лица", category: "Уход", base_price_minor: 1_500_000, duration_minutes: 60, sort_order: 2, is_active: true },
      { workspace_id: workspaceId, name: "Пилинг", category: "Уход", base_price_minor: 2_000_000, duration_minutes: 45, sort_order: 3, is_active: true },
      { workspace_id: workspaceId, name: "Аппаратная процедура", category: "Аппаратные", base_price_minor: 3_500_000, duration_minutes: 90, sort_order: 4, is_active: true },
      { workspace_id: workspaceId, name: "Инъекционная процедура", category: "Инъекции", base_price_minor: 4_500_000, duration_minutes: 60, sort_order: 5, is_active: true },
      { workspace_id: workspaceId, name: "Повторный приём", category: "Консультации", base_price_minor: 300_000, duration_minutes: 30, sort_order: 6, is_active: true },
    ],
    "услуги",
  );

  const doctors = await insert(
    "clinic_doctors",
    [
      { workspace_id: workspaceId, full_name: "Сауле Абишева", specialty: "Косметолог", sort_order: 1, is_active: true },
      { workspace_id: workspaceId, full_name: "Айжан Нурланова", specialty: "Дерматолог", sort_order: 2, is_active: true },
      { workspace_id: workspaceId, full_name: "Наргиз Оспанова", specialty: "Косметолог", sort_order: 3, is_active: true },
    ],
    "врачи",
  );

  // Недельный образец: будни рабочие, воскресенье выходной. У выходного оба
  // минутных поля пустые — этого требует ограничение таблицы.
  const shifts: Array<Record<string, unknown>> = [];
  for (const doctor of doctors) {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const working = weekday <= 6;
      shifts.push({
        workspace_id: workspaceId,
        doctor_id: doctor.id,
        weekday,
        is_working: working,
        start_minute: working ? 9 * 60 : null,
        end_minute: working ? 20 * 60 : null,
      });
    }
  }
  await insert("clinic_doctor_shifts", shifts, "график");

  const firstNames = ["Айнур", "Мадина", "Ольга", "Дана", "Гульнара", "Алия", "Жанна", "Ирина", "Асем", "Камила"];
  const lastNames = ["Садыкова", "Ержан", "Петрова", "Мухамед", "Абенова", "Ким", "Смагулова", "Ли", "Танирберген", "Ахметова"];
  const sources = ["WhatsApp", "Instagram", "Рекомендация", "Ресепшн", "Сайт"];

  const clients = await insert(
    "clients",
    Array.from({ length: 42 }, (_, index) => ({
      workspace_id: workspaceId,
      full_name: `${pick(firstNames, index)} ${pick(lastNames, index * 3 + 1)}`,
      phone: phone("client", index),
      whatsapp: phone("client", index),
      source: pick(sources, index),
      status: pick(["new", "active", "repeat", "active"], index),
      notes: pick(["Просит напомнить за час", "Удобно после 18:00", "", "Приходит с подругой"], index),
      last_visit_at: at(-((index % 30) + 1), 12, 0),
    })),
    "клиенты",
  );

  await insert(
    "leads",
    Array.from({ length: 58 }, (_, index) => {
      // Заявка, дошедшая до пациента, — это ТОТ ЖЕ человек: имя и телефон
      // берутся у клиента, на которого она ссылается. Прежняя версия ставила
      // client_id независимо от имени, и заявка «Асем Абенова» указывала на
      // карточку «Гульнары Мухамед»: задача, поставленная из такой заявки,
      // уходила в историю не того пациента.
      const linked = index % 6 === 4 ? clients[index % clients.length] : null;
      return {
        workspace_id: workspaceId,
        full_name: linked ? String(linked.full_name) : `${pick(firstNames, index * 2)} ${pick(lastNames, index)}`,
        phone: linked ? String(linked.phone) : phone("lead", index),
        source: pick(sources, index * 2),
        campaign: index % 4 === 0 ? "Instagram, август" : null,
        status: linked ? "booked" : pick(["new", "new", "in_progress", "in_progress", "lost"], index),
        notes: pick(["Спрашивает про свободное время", "", "Просит перезвонить вечером"], index),
        client_id: linked ? linked.id : null,
        responsible_user_id: pick([owner.id, reception.id], index),
      };
    }),
    "заявки",
  );

  // Записи: неделя назад — неделя вперёд, без пересечений у одного врача.
  const appointments: Array<Record<string, unknown>> = [];
  let slot = 0;
  for (let day = -7; day <= 7; day += 1) {
    // Воскресенье в графике выше объявлено выходным для всех врачей. Запись в
    // выходной — не «полнее выглядит», а противоречие, которое экран показывает
    // прямо: под строкой «Вс: выходной» стоят визиты.
    if (clinicWeekday(day) === 7) continue;

    const perDay = day === 0 ? 9 : 6;
    for (let n = 0; n < perDay; n += 1) {
      const doctor = doctors[n % doctors.length];
      const service = pick(services, slot);
      const client = pick(clients, slot);
      // Час зависит от номера приёма у ЭТОГО врача в этот день, поэтому два
      // приёма одного врача никогда не попадают в один слот. Шаг в три часа
      // разносит визиты по смене: прежние два часа держали всю клинику в 09:00
      // и 11:00, а девять часов смены оставались пустыми.
      const hour = 9 + Math.floor(n / doctors.length) * 3;
      appointments.push({
        workspace_id: workspaceId,
        client_id: client.id,
        client_name: client.full_name,
        client_phone: client.phone,
        service: service.name,
        service_id: service.id,
        doctor_name: doctor.full_name,
        doctor_id: doctor.id,
        starts_at: at(day, hour, 0),
        duration_minutes: Number(service.duration_minutes) || 60,
        status: day < 0 ? pick(["arrived", "arrived", "no_show"], slot) : pick(["scheduled", "confirmed"], slot),
        source: pick(sources, slot),
        notes: "",
      });
      slot += 1;
    }
  }
  const savedAppointments = await insert("appointments", appointments, "записи");

  // Продажи: у оплаченных обязательно paid_at, и часть — сегодняшним днём
  // клиники, иначе плитка «Выручка сегодня» покажет ноль при полной базе.
  const deals: Array<Record<string, unknown>> = savedAppointments
    .filter((appointment) => appointment.status === "arrived" || appointment.status === "confirmed")
    .map((appointment, index) => {
      const service = services.find((item) => item.id === appointment.service_id) || services[0];
      // Оплата не может быть датирована будущим. Прежняя версия ставила
      // paid_at равным времени записи, включая записи на неделю вперёд, и
      // четверть суммы на экране продаж оказывалась платежами из будущего.
      const startsAt = String(appointment.starts_at);
      const inFuture = Date.parse(startsAt) > Date.now();
      const paid = index % 3 !== 2 && !inFuture;
      const today = paid && index % 5 === 0;
      return {
        workspace_id: workspaceId,
        title: String(service.name),
        amount_minor: Number(service.base_price_minor) || 0,
        currency: "KZT",
        status: paid ? "paid" : "pending",
        service_id: service.id,
        client_id: appointment.client_id,
        appointment_id: appointment.id,
        paid_at: paid ? (today ? at(0, 13, 0) : startsAt) : null,
      };
    });
  await insert("deals", deals, "продажи");

  await insert(
    "tasks",
    Array.from({ length: 18 }, (_, index) => ({
      workspace_id: workspaceId,
      title: pick(["Перезвонить по заявке", "Подтвердить запись", "Напомнить о визите", "Уточнить удобное время"], index),
      description: "",
      assignee_user_id: pick([owner.id, reception.id], index),
      assignee_name: pick([String(owner.full_name), String(reception.full_name)], index),
      priority: pick(["low", "medium", "high"], index),
      status: pick(["new", "new", "in_progress", "done"], index),
      due_at: at((index % 5) - 1, 15, 0),
      completed_at: index % 4 === 3 ? at(-1, 16, 0) : null,
      created_by_staff_user_id: owner.id,
      created_by_kind: "manual",
    })),
    "задачи",
  );

  process.stdout.write(
    [
      "",
      "Готово. Дальше — руками, скриптом это не делается:",
      `  1. Пользователь Supabase Auth ${ownerAuthId} должен существовать — под ним вы входите.`,
      `  2. В браузере выберите клинику «${clinicName}».`,
      "  3. Подписку клиники заведите в панели владельца платформы.",
      "",
      "Проверьте счётчики на экранах: они посчитаны по этим самым строкам.",
      "",
    ].join("\n"),
  );
}

await main();
