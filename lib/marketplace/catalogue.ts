// Маркет приложений: каталог того, что клиника может подключить.
//
// Каталог живёт в коде, а не в базе, и это осознанно. Строка в таблице
// принимает любое значение provider — свободный текст без белого списка, — а
// каталог обязан описывать то, что в продукте ДЕЙСТВИТЕЛЬНО есть. Состояние
// подключения при этом берётся из integration_statuses (миграция 013): каталог
// говорит «что бывает», таблица — «что подключено у этой клиники».
//
// Этот продукт уже один раз объявлял провайдеров, которых в коде не было:
// ElevenLabs, HeyGen и TapNow перечислены в интерфейсе, а их ключи не читаются
// ни в одном месте — это записано в самом .env.example. Поэтому здесь у каждой
// карточки есть поле `state`, и оно выводится из наличия реализации, а не из
// намерения. Ничего «скоро» без этой пометки в каталоге быть не может.
//
// Отдельная правда, которую нельзя прятать: сегодня НИ ОДИН провайдер не
// подключается кнопкой. Секреты — одна платформенная переменная окружения на
// всех клиентов, а привязка канала к клинике делается вставкой в базу руками.
// Поэтому у карточек есть `setup`, и «сами в интерфейсе» там пока не стоит
// нигде. Обещать иное на экране — значит обещать работу, которой не сделано.

export type AppState =
  /** Реализовано и работает в обе стороны. */
  | "live"
  /** Реализовано частично: работает только одно направление. */
  | "inbound_only"
  /** В продукте нет ни строчки кода. Карточка существует ради заявки. */
  | "planned";

export type AppSetup =
  /** Настраивается вместе с нами: ключи платформенные, привязка руками. */
  | "with_us"
  /** Подключения нет вообще — можно только оставить заявку. */
  | "request";

export type AppCategory = "messengers" | "ads" | "ai" | "telephony" | "payments" | "analytics";

export type MarketplaceApp = {
  id: string;
  title: string;
  vendor: string;
  category: AppCategory;
  /** Что клиника получит. Без обещаний того, чего нет. */
  summary: string;
  state: AppState;
  setup: AppSetup;
  /**
   * Чего это приложение НЕ делает. Поле обязательное и не пустое у всего, что
   * работает частично: половина интеграции, поданная как целая, — самый дешёвый
   * способ обмануть на демонстрации.
   */
  limits: readonly string[];
  /** Провайдер в integration_statuses, если состояние где-то хранится. */
  provider?: string;
};

export const APP_CATEGORIES: Readonly<Record<AppCategory, string>> = {
  messengers: "Мессенджеры",
  ads: "Реклама",
  ai: "Искусственный интеллект",
  telephony: "Телефония",
  payments: "Платежи",
  analytics: "Аналитика",
};

export const MARKETPLACE_APPS: readonly MarketplaceApp[] = [
  {
    id: "wazzup",
    title: "Wazzup",
    vendor: "Wazzup",
    category: "messengers",
    summary: "Сообщения пациентов из WhatsApp попадают в CRM отдельной заявкой с номером и текстом.",
    state: "inbound_only",
    setup: "with_us",
    provider: "wazzup",
    limits: [
      "Отвечать пациенту из Negis нельзя — переписка ведётся в кабинете Wazzup",
      "Абонплата Wazzup оплачивается вендору отдельно от тарифа Negis",
    ],
  },
  {
    id: "whatsapp-cloud",
    title: "WhatsApp Business",
    vendor: "Meta",
    category: "messengers",
    summary: "Прямое подключение номера WhatsApp через Meta, без посредника: входящие становятся заявками.",
    state: "inbound_only",
    setup: "with_us",
    provider: "whatsapp_cloud",
    limits: [
      "Отправка сообщений из Negis не реализована",
      "Meta берёт плату за шаблоны сообщений отдельно",
    ],
  },
  {
    id: "meta-ads",
    title: "Реклама Meta",
    vendor: "Meta",
    category: "ads",
    summary: "Запуск кампаний в Instagram прямо из Negis и выгрузка статистики по ним.",
    state: "live",
    setup: "with_us",
    provider: "meta",
    limits: [
      "Кампании создаются на паузе — включает их человек в кабинете Meta",
      "Рекламный бюджет платится напрямую Meta",
    ],
  },
  {
    id: "openai",
    title: "Генерация креативов",
    vendor: "OpenAI",
    category: "ai",
    summary: "Тексты объявлений, изображения и видео для рекламы, проверка формулировок на модерацию Meta.",
    state: "live",
    setup: "with_us",
    provider: "openai",
    limits: [
      "Объём генераций ограничен тарифом",
      "Видео доступно только на тарифе Про",
    ],
  },
  {
    id: "targeting-agent",
    title: "Подбор аудитории",
    vendor: "Negis",
    category: "ads",
    summary: "Разбор ниши и предложение параметров аудитории для кампании.",
    state: "live",
    setup: "with_us",
    provider: "targeting",
    limits: ["Предложение аудитории — подсказка, решение остаётся за маркетологом"],
  },
  {
    id: "telephony",
    title: "Телефония",
    vendor: "—",
    category: "telephony",
    summary: "Звонок пациента становится заявкой, запись разговора хранится рядом с карточкой.",
    state: "planned",
    setup: "request",
    limits: [
      "В продукте не реализовано: ни одного провайдера телефонии в коде нет",
      "Звонки в CRM сейчас не попадают — заявку заводит регистратор руками",
    ],
  },
  {
    id: "payments",
    title: "Приём оплат",
    vendor: "—",
    category: "payments",
    summary: "Оплата процедуры по ссылке, статус платежа рядом с продажей.",
    state: "planned",
    setup: "request",
    limits: [
      "В продукте не реализовано: платёжных систем в коде нет",
      "Оплата сейчас отмечается в продаже вручную",
    ],
  },
  {
    id: "online-booking",
    title: "Онлайн-запись",
    vendor: "—",
    category: "analytics",
    summary: "Страница записи для пациента: свободные окна берутся из графика врачей.",
    state: "planned",
    setup: "request",
    limits: [
      "В продукте не реализовано: страницы записи для пациента нет",
      "График врачей и проверка пересечений уже работают — не хватает внешней страницы",
    ],
  },
];

export const APP_STATE_LABEL: Readonly<Record<AppState, string>> = {
  live: "Работает",
  inbound_only: "Работает частично",
  planned: "В разработке",
};

export const APP_SETUP_LABEL: Readonly<Record<AppSetup, string>> = {
  with_us: "Подключаем вместе с вами",
  request: "Оставить заявку",
};

/**
 * Подключено ли приложение у этой клиники.
 *
 * Строка состояния сама по себе ничего не доказывает: provider — свободный
 * текст, и в таблице может лежать запись о приложении, которого в каталоге нет.
 * Поэтому подключением считается только совпадение с каталогом плюс статус,
 * который действительно означает работу.
 */
export function isConnected(app: MarketplaceApp, statuses: Array<{ provider?: unknown; status?: unknown }>): boolean {
  if (!app.provider) return false;
  const row = statuses.find((item) => String(item.provider || "").toLowerCase() === app.provider);
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  return status === "connected" || status === "active" || status === "ok";
}

export function appsByCategory(): Array<{ category: AppCategory; title: string; apps: MarketplaceApp[] }> {
  const order: AppCategory[] = ["messengers", "ads", "ai", "telephony", "payments", "analytics"];
  return order
    .map((category) => ({
      category,
      title: APP_CATEGORIES[category],
      apps: MARKETPLACE_APPS.filter((app) => app.category === category),
    }))
    .filter((group) => group.apps.length > 0);
}
