export type AdvertisingAssistantAccess =
  | "idle"
  | "checking"
  | "ready"
  | "required"
  | "forbidden"
  | "error";

export type AdvertisingAssistantReason =
  | "loading"
  | "history_unavailable"
  | "launch_failed"
  | "video_processing"
  | "first_campaign"
  | "checking_results"
  | "insights_unavailable"
  | "insights_syncing"
  | "insights_not_synced"
  | "zero_delivery"
  | "link_paid_sales"
  | "link_leads"
  | "results_ready"
  | "campaigns_prepared";

export type AdvertisingAssistantBrief = {
  reason: AdvertisingAssistantReason;
  tone: "primary" | "success" | "warning" | "error" | "muted";
  title: string;
  text: string;
  actionLabel?: string;
  href?: "/ads-automation" | "/ads-automation/history" | "/admin" | "/leads" | "/sales";
};

export type AdvertisingAssistantInput = {
  launchLoadState: "loading" | "ready" | "error";
  createdLaunches: number;
  failedLaunches: number;
  processingLaunches: number;
  insightsAccess: AdvertisingAssistantAccess;
  campaignsWithInsights: number;
  insightsEmpty: number;
  insightsRunning: number;
  insightsNotSynced: number;
  crmAccess: AdvertisingAssistantAccess;
  unattributedLeads: number;
  paidUnattributedDeals: number;
};

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// The client assistant explains verified facts and chooses one safe next step.
// It never launches, pauses or edits an advertising campaign.
export function buildAdvertisingAssistantBrief(input: AdvertisingAssistantInput): AdvertisingAssistantBrief {
  const createdLaunches = safeCount(input.createdLaunches);
  const failedLaunches = safeCount(input.failedLaunches);
  const processingLaunches = safeCount(input.processingLaunches);
  const campaignsWithInsights = safeCount(input.campaignsWithInsights);
  const insightsEmpty = safeCount(input.insightsEmpty);
  const insightsRunning = safeCount(input.insightsRunning);
  const insightsNotSynced = safeCount(input.insightsNotSynced);
  const unattributedLeads = safeCount(input.unattributedLeads);
  const paidUnattributedDeals = safeCount(input.paidUnattributedDeals);

  if (input.launchLoadState === "loading") {
    return {
      reason: "loading",
      tone: "muted",
      title: "Проверяем рекламные запуски",
      text: "Собираем последние статусы кампаний и связанные результаты.",
      actionLabel: "Открыть историю",
      href: "/ads-automation/history",
    };
  }

  if (input.launchLoadState === "error") {
    return {
      reason: "history_unavailable",
      tone: "error",
      title: "Не удалось обновить историю",
      text: "Повторите проверку. Подготовка новой рекламы доступна отдельно.",
      actionLabel: "Повторить",
    };
  }

  if (failedLaunches > 0) {
    return {
      reason: "launch_failed",
      tone: "error",
      title: "Проверьте незавершённый запуск",
      text: `Запусков, требующих внимания: ${failedLaunches}. Причина и безопасный следующий шаг указаны в истории.`,
      actionLabel: "Проверить историю",
      href: "/ads-automation/history",
    };
  }

  if (processingLaunches > 0) {
    return {
      reason: "video_processing",
      tone: "warning",
      title: "Meta обрабатывает видео",
      text: `Видео в обработке: ${processingLaunches}. Дождитесь завершения перед повторными действиями.`,
      actionLabel: "Проверить статус",
      href: "/ads-automation/history",
    };
  }

  if (createdLaunches === 0) {
    return {
      reason: "first_campaign",
      tone: "primary",
      title: "Подготовьте первый рекламный запуск",
      text: "Добавьте креатив и ключевые параметры. Кампания будет создана выключенной.",
      actionLabel: "Создать рекламу",
      href: "/ads-automation",
    };
  }

  if (input.insightsAccess === "checking" || input.crmAccess === "checking") {
    return {
      reason: "checking_results",
      tone: "muted",
      title: "Проверяем результат",
      text: "Сопоставляем фактические данные Meta и вручную связанные записи CRM.",
      actionLabel: "Открыть историю",
      href: "/ads-automation/history",
    };
  }

  if (input.insightsAccess === "error") {
    return {
      reason: "insights_unavailable",
      tone: "warning",
      title: "Результаты Meta не обновились",
      text: "Кампании сохранены. Повторите получение фактических данных позже.",
      actionLabel: "Повторить",
    };
  }

  if (input.insightsAccess === "ready" && insightsRunning > 0) {
    return {
      reason: "insights_syncing",
      tone: "muted",
      title: "Meta обновляет результаты",
      text: "Синхронизация выполняется. Не запускайте её повторно, пока текущая проверка не завершилась.",
      actionLabel: "Открыть историю",
      href: "/ads-automation/history",
    };
  }

  if (input.insightsAccess === "ready" && insightsNotSynced > 0) {
    return {
      reason: "insights_not_synced",
      tone: "warning",
      title: "Получите фактические данные Meta",
      text: `Кампаний без синхронизации: ${insightsNotSynced}. Ручная проверка доступна владельцу в настройках.`,
      actionLabel: "Открыть настройки",
      href: "/admin",
    };
  }

  if (input.insightsAccess === "ready" && campaignsWithInsights === 0 && insightsEmpty > 0) {
    return {
      reason: "zero_delivery",
      tone: "muted",
      title: "Meta пока не вернула показы",
      text: "Для выключенной или ещё не откручивавшейся кампании это нормальное состояние.",
      actionLabel: "Открыть историю",
      href: "/ads-automation/history",
    };
  }

  if (input.crmAccess === "ready" && paidUnattributedDeals > 0) {
    return {
      reason: "link_paid_sales",
      tone: "warning",
      title: "Свяжите оплаченные продажи с рекламой",
      text: `Оплаченных продаж без выбранной кампании: ${paidUnattributedDeals}. Связь ставится вручную и не меняет рекламу.`,
      actionLabel: "Открыть продажи",
      href: "/sales",
    };
  }

  if (input.crmAccess === "ready" && unattributedLeads > 0) {
    return {
      reason: "link_leads",
      tone: "warning",
      title: "Свяжите заявки с рекламой",
      text: `Заявок без выбранной кампании: ${unattributedLeads}. Это подготовит данные для будущего честного отчёта.`,
      actionLabel: "Открыть заявки",
      href: "/leads",
    };
  }

  if (input.insightsAccess === "ready" && campaignsWithInsights > 0) {
    return {
      reason: "results_ready",
      tone: "success",
      title: "Фактические данные обновлены",
      text: "Расходы Meta и результат CRM показаны отдельно. Здесь нет автоматической оценки эффективности.",
      actionLabel: "Открыть историю",
      href: "/ads-automation/history",
    };
  }

  return {
    reason: "campaigns_prepared",
    tone: "success",
    title: "Кампании подготовлены безопасно",
    text: `Создано выключенных кампаний: ${createdLaunches}. Включение бюджета остаётся под контролем владельца.`,
    actionLabel: "Открыть историю",
    href: "/ads-automation/history",
  };
}
