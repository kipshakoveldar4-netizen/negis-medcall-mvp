import { useMemo, useState, type CSSProperties } from "react";
import { Activity, BarChart3, BrainCircuit, FileText, Rocket, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { apiUrl } from "@/lib/api";

type ApiSuccess<TData = unknown> = {
  success: true;
  mode: string;
  data: TData;
};

type ApiError = {
  success: false;
  error: string;
  details: string[];
};

type ApiResponse<TData = unknown> = ApiSuccess<TData> | ApiError;

type AnalyzeData = {
  creativeScore?: number;
  problems?: string[];
  recommendations?: string[];
  targetAudience?: Record<string, unknown>;
  campaignSettings?: Record<string, unknown>;
  budgetRecommendation?: Record<string, unknown>;
  expectedMetrics?: Record<string, unknown>;
  summary?: string;
};

type LaunchData = {
  campaignId?: string;
  status?: string;
  storageMode?: string;
  message?: string;
};

type ReportData = {
  campaignId?: string;
  report?: {
    status?: string;
    executiveSummary?: string;
    metrics?: Record<string, unknown>;
    insights?: string[];
    recommendations?: string[];
    nextSteps?: string[];
  };
};

type TargetingRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type DetailItem = {
  label: string;
  value: string;
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #E7ECF3",
  background: "#F8FAFC",
  color: "#0B1220",
  fontSize: 13,
  padding: "10px 12px",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 11,
  fontWeight: 700,
  color: "#64748B",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const sectionTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#0B1220",
  fontSize: 15,
  fontWeight: 800,
  marginBottom: 16,
};

const initialCreative = {
  clinicName: "Concept Clinic",
  niche: "cosmetology",
  city: "Astana",
  offer: "Free consultation and diagnostics",
  creativeText: "Free cosmetology consultation in Astana. Book your appointment on WhatsApp today.",
  targetAudience: "Women 25-45",
};

const initialLaunch = {
  campaignName: "Astana Cosmetology Free Consultation",
  budget: "300",
  objective: "leads",
};

const defaultProblems = [
  "Проверьте, что оффер не обещает медицинский результат без консультации.",
  "Добавьте конкретный следующий шаг: запись в WhatsApp или звонок администратора.",
];

const defaultRecommendations = [
  "Запустить A/B тест с двумя вариантами заголовка и одним коротким видео.",
  "Разделить аудитории по возрасту 25-34 и 35-55, чтобы увидеть разницу CPL.",
  "Оставить дневной бюджет в тестовом диапазоне и оценивать результат через 5-7 дней.",
];

const defaultInsights = [
  "Кампания готова для CRM-просмотра с mock performance data.",
  "Основной интерес дают аудитории с запросом на консультацию и диагностику.",
  "Для MVP достаточно отслеживать лиды, звонки и записи без подключения Meta API.",
];

const defaultReportRecommendations = [
  "Продолжить тест в Instagram Stories и Reels.",
  "Усилить текст оффера конкретным действием: бесплатная диагностика и запись сегодня.",
  "Перед production-запуском подключить реальные рекламные метрики.",
];

const defaultNextSteps = [
  "Проверить качество лидов в CRM.",
  "Передать кампанию маркетологу на ручной запуск.",
  "Подключить реальные расходы и конверсии на следующем этапе.",
];

function isApiError(response: ApiResponse): response is ApiError {
  return response.success === false;
}

async function requestJson<TData>(path: string, init?: TargetingRequestInit): Promise<ApiResponse<TData>> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();

  if (!text) {
    return {
      success: false,
      error: "Empty response",
      details: ["Сервис вернул пустой ответ."],
    };
  }

  try {
    return JSON.parse(text) as ApiResponse<TData>;
  } catch {
    return {
      success: false,
      error: "Invalid JSON response",
      details: ["Сервис вернул ответ в неожиданном формате."],
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const text = value.map((item) => textValue(item)).filter(Boolean).join(", ");
    return text || null;
  }
  if (typeof value === "object") return null;
  const text = String(value).trim();
  return text || null;
}

function pickText(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return fallback;
}

function pickNumber(record: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = record[key];
    const value = typeof raw === "number" ? raw : Number(textValue(raw));
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function listValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.map((item) => textValue(item)).filter((item): item is string => Boolean(item));
    if (items.length > 0) return items;
  }

  const single = textValue(value);
  if (single) return [single];

  return fallback;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function readDemoWorkspaceId(): string | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    const rawWorkspace = window.localStorage.getItem("negis_demo_workspace");
    if (!rawWorkspace) return undefined;

    const workspace = JSON.parse(rawWorkspace) as { id?: unknown };
    return typeof workspace.id === "string" && workspace.id.trim() ? workspace.id.trim() : undefined;
  } catch {
    return undefined;
  }
}

function Field({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...inputStyle, minHeight: 112, resize: "vertical" }}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input style={inputStyle} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function ListBlock({ title, items }: { title: string; items?: string[] }) {
  const safeItems = items?.length ? items : ["Данные появятся после анализа."];

  return (
    <div className="neu-sm p-4">
      <p className="text-xs font-bold uppercase text-[#64748B] mb-3">{title}</p>
      <ul className="space-y-2">
        {safeItems.map((item, index) => (
          <li key={`${item}-${index}`} className="text-sm text-[#334155] leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailGrid({ title, items, icon: Icon }: { title: string; items: DetailItem[]; icon?: LucideIcon }) {
  return (
    <div className="neu-sm p-4 min-w-0">
      <div className="mb-4 flex items-center gap-2">
        {Icon && <Icon size={15} className="text-[#1A56DB]" />}
        <p className="text-xs font-bold uppercase text-[#64748B]">{title}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl border border-[#E7ECF3] bg-white p-3">
            <p className="text-[11px] font-bold uppercase text-[#94A3B8]">{item.label}</p>
            <p className="mt-1 text-sm font-semibold leading-relaxed text-[#0B1220]">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCards({ items }: { items: DetailItem[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="neu-sm p-4">
          <p className="text-xs font-bold uppercase text-[#64748B]">{item.label}</p>
          <p className="mt-2 text-2xl font-black text-[#0B1220]">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export default function TargetingAgent() {
  const [creative, setCreative] = useState(initialCreative);
  const [launch, setLaunch] = useState(initialLaunch);
  const [reportCampaignId, setReportCampaignId] = useState("");
  const [analysis, setAnalysis] = useState<ApiSuccess<AnalyzeData> | null>(null);
  const [launchResult, setLaunchResult] = useState<ApiSuccess<LaunchData> | null>(null);
  const [report, setReport] = useState<ApiSuccess<ReportData> | null>(null);
  const [loading, setLoading] = useState<"health" | "analyze" | "launch" | "report" | null>(null);
  const [health, setHealth] = useState<ApiResponse | null>(null);

  const updateCreative = (key: keyof typeof initialCreative, value: string) => {
    setCreative((current) => ({ ...current, [key]: value }));
  };

  const updateLaunch = (key: keyof typeof initialLaunch, value: string) => {
    setLaunch((current) => ({ ...current, [key]: value }));
  };

  const handleApiError = (response: ApiResponse) => {
    if (isApiError(response)) {
      toast.error(response.error, {
        description: response.details.join(", ") || undefined,
      });
    }
  };

  const checkHealth = async () => {
    setLoading("health");
    try {
      const response = await requestJson("/api/targeting/health");
      setHealth(response);
      if (isApiError(response)) handleApiError(response);
      else toast.success("Сервис ИИ-таргетолога доступен");
    } catch {
      toast.error("Не удалось проверить статус сервиса");
    } finally {
      setLoading(null);
    }
  };

  const analyzeCreative = async () => {
    setLoading("analyze");
    try {
      const response = await requestJson<AnalyzeData>("/api/targeting/analyze", {
        method: "POST",
        body: JSON.stringify(creative),
      });
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setAnalysis(response);
      toast.success("Креатив проанализирован");
    } catch {
      toast.error("Не удалось выполнить анализ");
    } finally {
      setLoading(null);
    }
  };

  const launchCampaign = async () => {
    setLoading("launch");
    try {
      const response = await requestJson<LaunchData>("/api/targeting/launch", {
        method: "POST",
        body: JSON.stringify({
          ...creative,
          campaignName: launch.campaignName,
          budget: Number(launch.budget),
          objective: launch.objective,
          workspaceId: readDemoWorkspaceId(),
          analysis: analysis?.data,
        }),
      });
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setLaunchResult(response);
      const createdCampaignId = response.data.campaignId?.trim();
      if (createdCampaignId) setReportCampaignId(createdCampaignId);
      toast.success("Черновик кампании создан");
    } catch {
      toast.error("Не удалось создать кампанию");
    } finally {
      setLoading(null);
    }
  };

  const getReport = async () => {
    const campaignId = reportCampaignId.trim();

    if (!campaignId) {
      toast.error("Validation error", {
        description: "campaignId is required",
      });
      return;
    }

    setLoading("report");
    try {
      const response = await requestJson<ReportData>(
        `/api/targeting/report?campaignId=${encodeURIComponent(campaignId)}`,
      );
      if (isApiError(response)) {
        handleApiError(response);
        return;
      }
      setReport(response);
      toast.success("Отчёт загружен");
    } catch {
      toast.error("Не удалось получить отчёт");
    } finally {
      setLoading(null);
    }
  };

  const analysisCards = useMemo(() => {
    if (!analysis) return null;

    const targetAudience = asRecord(analysis.data.targetAudience);
    const campaignSettings = asRecord(analysis.data.campaignSettings);
    const budget = asRecord(analysis.data.budgetRecommendation);
    const expected = asRecord(analysis.data.expectedMetrics);

    return {
      targetAudience: [
        { label: "Возраст", value: pickText(targetAudience, ["ageRange", "age", "ages"], "25-55") },
        { label: "Пол", value: pickText(targetAudience, ["gender", "genders"], "женщины 75%, мужчины 25%") },
        { label: "Гео", value: pickText(targetAudience, ["geo", "location", "city"], creative.city || "Астана") },
        {
          label: "Интересы",
          value: pickText(
            targetAudience,
            ["interests", "interestCategories"],
            "косметология, красота, клиники, wellness, медицинские услуги",
          ),
        },
        {
          label: "Сегменты",
          value: pickText(
            targetAudience,
            ["segments", "audienceSegments"],
            "новые пациенты, тёплая аудитория, look-alike по CRM",
          ),
        },
        {
          label: "Исключения",
          value: pickText(targetAudience, ["exclusions"], "существующие клиенты и нерелевантные интересы"),
        },
      ],
      campaignSettings: [
        { label: "Цель", value: pickText(campaignSettings, ["objective", "goal"], "лиды / WhatsApp-сообщения") },
        {
          label: "Площадки",
          value: pickText(campaignSettings, ["placements", "platforms"], "Instagram Reels, Stories, Facebook Feed"),
        },
        { label: "Дневной бюджет", value: pickText(campaignSettings, ["dailyBudget", "budget"], "20-50 USD") },
        {
          label: "Расписание",
          value: pickText(campaignSettings, ["schedule", "hours"], "ежедневно 09:00-21:00"),
        },
        { label: "Ставка", value: pickText(campaignSettings, ["bidStrategy", "bidding"], "Lowest cost") },
        { label: "Оптимизация", value: pickText(campaignSettings, ["optimization"], "лид или сообщение в WhatsApp") },
      ],
      budget: [
        { label: "Тестовый бюджет", value: pickText(budget, ["testBudget", "recommendedBudget", "total"], "150-300 USD") },
        { label: "Дневной лимит", value: pickText(budget, ["dailyBudget", "daily"], "20-50 USD") },
        { label: "Период", value: pickText(budget, ["period", "duration"], "5-7 дней") },
        { label: "KZT", value: pickText(budget, ["kzt", "localCurrency"], "7 000 ₸ daily / 49 000 ₸ total") },
        {
          label: "Логика",
          value: pickText(
            budget,
            ["explanation", "reasoning"],
            "Достаточно для первичного теста оффера и оценки стоимости лида.",
          ),
        },
        {
          label: "Контроль",
          value: pickText(budget, ["guardrail", "control"], "остановить тест, если CPL выше плана 2 дня подряд"),
        },
      ],
      expectedMetrics: [
        { label: "CPL", value: pickText(expected, ["cpl", "costPerLead"], "1.5-4 USD") },
        { label: "CTR", value: pickText(expected, ["ctr"], "1.2-2.5%") },
        { label: "Конверсия", value: pickText(expected, ["conversionRate", "conversion"], "8-15%") },
        { label: "Показы", value: pickText(expected, ["impressions"], "8 000-18 000") },
        { label: "Лиды", value: pickText(expected, ["leads"], "18-35") },
        { label: "Цена лида", value: pickText(expected, ["costPerLeadKzt", "cplKzt"], "700-1 900 ₸") },
        { label: "Записи", value: pickText(expected, ["appointments", "bookings"], "5-12") },
      ],
    };
  }, [analysis, creative.city]);

  const reportCards = useMemo(() => {
    if (!report) return null;

    const metrics = asRecord(report.data.report?.metrics);
    const impressions = pickNumber(metrics, ["impressions", "views"], 12500);
    const clicks = pickNumber(metrics, ["clicks"], 420);
    const leads = pickNumber(metrics, ["leads"], 24);
    const appointments = pickNumber(metrics, ["appointments", "bookings"], 7);
    const spend = pickNumber(metrics, ["spend", "spendUsd", "adSpend"], 300);
    const ctr = pickText(metrics, ["ctr"], "3.36%");
    const cpl = pickText(metrics, ["cpl", "costPerLead"], "12.5 USD");
    const appointmentCost = pickText(metrics, ["costPerAppointment", "costPerBooking"], "42.8 USD");

    return [
      { label: "Показы", value: formatNumber(impressions) },
      { label: "Клики", value: formatNumber(clicks) },
      { label: "Лиды", value: formatNumber(leads) },
      { label: "Записи", value: formatNumber(appointments) },
      { label: "Расход", value: `${formatNumber(spend)} USD` },
      { label: "CTR", value: ctr },
      { label: "Цена лида", value: cpl },
      { label: "Цена записи", value: appointmentCost },
    ];
  }, [report]);

  return (
    <PageLayout requireAuth={false}>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-[#0B1220]">ИИ таргетолог</h2>
            <p className="text-sm text-[#64748B] mt-1">
              Анализ креатива, черновик кампании и отчёт по MedCall Targeting Agent.
            </p>
          </div>
          <button
            className="neu-btn flex items-center gap-2 text-sm px-4 py-2"
            onClick={checkHealth}
            disabled={loading === "health"}
          >
            <Activity size={15} />
            {loading === "health" ? "Проверяем..." : "Статус сервиса"}
          </button>
        </div>

        {health && (
          <div className="neu-sm p-4 text-sm text-[#334155]">
            Статус сервиса:{" "}
            {health.success ? (
              <span className="font-bold text-green-600">доступен ({health.mode})</span>
            ) : (
              <span className="font-bold text-red-500">{health.error}</span>
            )}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <BrainCircuit size={18} />
              Анализ креатива
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Клиника" value={creative.clinicName} onChange={(value) => updateCreative("clinicName", value)} />
              <Field label="Ниша" value={creative.niche} onChange={(value) => updateCreative("niche", value)} />
              <Field label="Город" value={creative.city} onChange={(value) => updateCreative("city", value)} />
              <Field label="Оффер" value={creative.offer} onChange={(value) => updateCreative("offer", value)} />
              <div className="md:col-span-2">
                <Field
                  label="Текст креатива"
                  value={creative.creativeText}
                  onChange={(value) => updateCreative("creativeText", value)}
                  textarea
                />
              </div>
              <div className="md:col-span-2">
                <Field
                  label="Целевая аудитория"
                  value={creative.targetAudience}
                  onChange={(value) => updateCreative("targetAudience", value)}
                />
              </div>
            </div>
            <button
              className="neu-btn-primary mt-5 flex items-center gap-2 text-sm px-5 py-2.5"
              onClick={analyzeCreative}
              disabled={loading === "analyze"}
            >
              <BrainCircuit size={15} />
              {loading === "analyze" ? "Анализируем..." : "Анализировать креатив"}
            </button>
          </section>

          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <Rocket size={18} />
              Черновик кампании
            </h3>
            <div className="space-y-4">
              <Field
                label="Название кампании"
                value={launch.campaignName}
                onChange={(value) => updateLaunch("campaignName", value)}
              />
              <Field label="Бюджет" value={launch.budget} onChange={(value) => updateLaunch("budget", value)} />
              <Field
                label="Цель"
                value={launch.objective}
                onChange={(value) => updateLaunch("objective", value)}
              />
            </div>
            <button
              className="neu-btn-primary mt-5 flex items-center gap-2 text-sm px-5 py-2.5"
              onClick={launchCampaign}
              disabled={loading === "launch"}
            >
              <Rocket size={15} />
              {loading === "launch" ? "Создаём..." : "Создать кампанию"}
            </button>

            {launchResult && (
              <div className="neu-sm p-4 mt-5 text-sm text-[#334155] space-y-2">
                <p>
                  Статус: <span className="font-bold">{launchResult.data.status ?? "pending"}</span>
                </p>
                <p>
                  Хранилище: <span className="font-bold">{launchResult.data.storageMode ?? "demo"}</span>
                </p>
                <p className="break-all">
                  ID кампании: <span className="font-mono">{launchResult.data.campaignId ?? "Данные появятся после создания."}</span>
                </p>
              </div>
            )}
          </section>
        </div>

        {analysis && analysisCards && (
          <section className="neu-card p-6">
            <h3 style={sectionTitleStyle}>
              <BarChart3 size={18} />
              Результат анализа
            </h3>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="neu-sm p-4">
                <p className="text-xs font-bold uppercase text-[#64748B] mb-2">Оценка креатива</p>
                <p className="text-3xl font-black text-[#1A56DB]">
                  Оценка креатива: {analysis.data.creativeScore ?? 92}/100
                </p>
                <p className="text-sm text-[#64748B] mt-3 leading-relaxed">
                  {analysis.data.summary || "Креатив подходит для тестовой кампании в нише косметологии."}
                </p>
              </div>
              <ListBlock title="Что нужно проверить" items={listValue(analysis.data.problems, defaultProblems)} />
              <ListBlock title="Рекомендации AI" items={listValue(analysis.data.recommendations, defaultRecommendations)} />
            </div>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <DetailGrid title="Целевая аудитория" icon={BrainCircuit} items={analysisCards.targetAudience} />
              <DetailGrid title="Настройки кампании" icon={Rocket} items={analysisCards.campaignSettings} />
              <DetailGrid title="Рекомендация по бюджету" icon={BarChart3} items={analysisCards.budget} />
              <DetailGrid title="Ожидаемые метрики" icon={FileText} items={analysisCards.expectedMetrics} />
            </div>
          </section>
        )}

        <section className="neu-card p-6">
          <h3 style={sectionTitleStyle}>
            <FileText size={18} />
            Отчёт по кампании
          </h3>
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              style={inputStyle}
              value={reportCampaignId}
              onChange={(event) => setReportCampaignId(event.target.value)}
              placeholder="campaignId"
            />
            <button
              className="neu-btn-primary flex items-center justify-center gap-2 text-sm px-5 py-2.5 shrink-0"
              onClick={getReport}
              disabled={loading === "report"}
            >
              <FileText size={15} />
              {loading === "report" ? "Загружаем..." : "Получить отчёт"}
            </button>
          </div>

          {report && (
            <div className="mt-5 space-y-4">
              <div className="neu-sm p-4">
                <p className="text-xs font-bold uppercase text-[#64748B] mb-2">Краткое резюме</p>
                <p className="text-sm text-[#334155] leading-relaxed">
                  {report.data.report?.executiveSummary || "Кампания готова для CRM-просмотра с mock performance data."}
                </p>
              </div>
              {reportCards && <MetricCards items={reportCards} />}
              <div className="grid gap-4 lg:grid-cols-3">
                <ListBlock title="Инсайты" items={listValue(report.data.report?.insights, defaultInsights)} />
                <ListBlock
                  title="Рекомендации"
                  items={listValue(report.data.report?.recommendations, defaultReportRecommendations)}
                />
                <ListBlock title="Следующие шаги" items={listValue(report.data.report?.nextSteps, defaultNextSteps)} />
              </div>
            </div>
          )}
        </section>
      </div>
    </PageLayout>
  );
}
