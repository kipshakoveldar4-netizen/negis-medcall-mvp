import type { CSSProperties, ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  CalendarCheck,
  CheckCircle2,
  Circle,
  Clapperboard,
  ClipboardList,
  DollarSign,
  Inbox,
  Megaphone,
  MessageCircle,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { defaultThemePresetId, getThemePreset } from "@/lib/themePresets";

// D3 — AI Control Center UI MVP (Glass Morphic Medical AI). UI-first: this screen
// establishes the owner's daily picture. No real analytics are wired yet, so every
// metric shows "—" and AI recommendations are clearly labelled as examples. Visuals
// use the --negis-* theme tokens (see docs/DESIGN-SYSTEM.md §7, §14).

const EMPTY_METRIC_HINT = "Данные появятся после подключения CRM.";

type Tone = "primary" | "ai" | "success" | "warning" | "error" | "muted";

function toneColor(tone: Tone): string {
  return `var(--negis-${tone === "muted" ? "muted" : tone})`;
}

function toneSoftBg(tone: Tone): string {
  switch (tone) {
    case "ai":
      return "rgba(124,58,237,0.10)";
    case "success":
      return "rgba(16,185,129,0.12)";
    case "warning":
      return "rgba(245,158,11,0.14)";
    case "error":
      return "rgba(239,68,68,0.10)";
    case "muted":
      return "rgba(148,163,184,0.14)";
    default:
      return "var(--negis-primary-soft)";
  }
}

function ControlMetricCard({ label, icon: Icon, tone }: { label: string; icon: LucideIcon; tone: Tone }) {
  return (
    <div className="negis-glass p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: toneSoftBg(tone), color: toneColor(tone) }}>
          <Icon size={18} />
        </div>
        <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{label}</p>
      </div>
      <p className="mt-3 text-3xl font-black" style={{ color: "var(--negis-text)" }}>—</p>
      <p className="mt-1 text-xs font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>{EMPTY_METRIC_HINT}</p>
    </div>
  );
}

type Priority = "high" | "medium" | "low";

const priorityMeta: Record<Priority, { label: string; tone: Tone }> = {
  high: { label: "Высокий", tone: "error" },
  medium: { label: "Средний", tone: "warning" },
  low: { label: "Низкий", tone: "muted" },
};

function AIActionCard({
  title,
  priority,
  explanation,
  action,
  openHref,
}: {
  title: string;
  priority: Priority;
  explanation: string;
  action: string;
  openHref?: string;
}) {
  const meta = priorityMeta[priority];
  return (
    <div className="negis-glass flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: "rgba(124,58,237,0.10)", color: "var(--negis-ai)" }}>
            <Sparkles size={16} />
          </div>
          <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{title}</p>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.06em]"
          style={{ background: toneSoftBg(meta.tone), color: toneColor(meta.tone) }}
        >
          {meta.label}
        </span>
      </div>
      <p className="text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>{explanation}</p>
      <p className="text-sm font-bold" style={{ color: "var(--negis-text)" }}>
        Действие: <span style={{ color: "var(--negis-primary)" }}>{action}</span>
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {openHref ? (
          <Link href={openHref}>
            <button type="button" className="neu-btn justify-center px-4 py-2 text-xs">Открыть</button>
          </Link>
        ) : (
          <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled>Открыть</button>
        )}
        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled title="Появится после подключения задач">
          Создать задачу
        </button>
        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled title="Появится на следующем этапе">
          Подробнее
        </button>
      </div>
    </div>
  );
}

function QuickActionButton({ label, icon: Icon, href, disabled }: { label: string; icon: LucideIcon; href?: string; disabled?: boolean }) {
  const inner = (
    <button
      type="button"
      className={`neu-btn justify-center gap-2 px-4 py-2.5 text-sm ${disabled ? "opacity-60" : ""}`}
      disabled={disabled}
      title={disabled ? "Появится на следующем этапе" : undefined}
    >
      <Icon size={16} />
      {label}
    </button>
  );
  if (disabled || !href) return inner;
  return <Link href={href}>{inner}</Link>;
}

type FlowState = "active" | "soon" | "pending";

function BusinessFlowStep({ label, state }: { label: string; state: FlowState }) {
  const tag = state === "active" ? "" : state === "soon" ? "скоро" : "данные не подключены";
  const color = state === "active" ? "var(--negis-primary)" : "var(--negis-muted)";
  return (
    <div
      className="negis-glass flex shrink-0 flex-col gap-1 px-4 py-3"
      style={{ minWidth: 128 }}
    >
      <span className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{label}</span>
      {tag ? <span className="text-[10px] font-black uppercase tracking-[0.06em]" style={{ color }}>{tag}</span> : (
        <span className="text-[10px] font-black uppercase tracking-[0.06em]" style={{ color: "var(--negis-primary)" }}>активно</span>
      )}
    </div>
  );
}

function ReadinessRow({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {ready ? (
        <CheckCircle2 size={18} style={{ color: "var(--negis-success)" }} />
      ) : (
        <Circle size={18} style={{ color: "var(--negis-muted)" }} />
      )}
      <span className="text-sm font-bold" style={{ color: ready ? "var(--negis-text)" : "var(--negis-muted)" }}>{label}</span>
      <span className="ml-auto text-xs font-bold" style={{ color: "var(--negis-muted)" }}>{ready ? "готово" : "ожидает"}</span>
    </div>
  );
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>{children}</h2>
      {hint ? <p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>{hint}</p> : null}
    </div>
  );
}

const chipStyle: CSSProperties = {
  borderRadius: 999,
  padding: "4px 12px",
  fontSize: 11,
  fontWeight: 800,
};

export default function AiControlCenter() {
  const theme = getThemePreset(defaultThemePresetId);
  const todayLabel = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

  const metrics: Array<{ label: string; icon: LucideIcon; tone: Tone }> = [
    { label: "Новые заявки", icon: Inbox, tone: "primary" },
    { label: "Необработанные лиды", icon: Users, tone: "warning" },
    { label: "Записи сегодня", icon: CalendarCheck, tone: "primary" },
    { label: "Пациенты для повторного визита", icon: RefreshCw, tone: "ai" },
    { label: "Реклама требует внимания", icon: Megaphone, tone: "warning" },
    { label: "Выручка сегодня", icon: DollarSign, tone: "success" },
  ];

  const recommendations: Array<{ title: string; priority: Priority; explanation: string; action: string; openHref?: string }> = [
    { title: "Лиды без ответа", priority: "high", explanation: "Часть заявок ждёт первого ответа. Быстрый ответ повышает шанс записи.", action: "Ответить в течение 15 минут", openHref: "/leads" },
    { title: "Кампания требует проверки", priority: "medium", explanation: "Рекламу стоит проверить перед включением в Ads Manager.", action: "Открыть автозапуск рекламы", openHref: "/ads-automation" },
    { title: "Пациентов можно вернуть", priority: "medium", explanation: "Есть пациенты, которым пора на повторный визит.", action: "Подготовить сообщение для WhatsApp", openHref: "/clients" },
    { title: "Администратор не обработал заявку", priority: "high", explanation: "Заявка висит без действия. Назначьте ответственного.", action: "Назначить задачу администратору", openHref: "/tasks" },
    { title: "Контент-идея на основе частого вопроса", priority: "low", explanation: "Частый вопрос пациентов можно превратить в рекламный контент.", action: "Создать пакет в контент-студии", openHref: "/content-studio" },
  ];

  const flowSteps: Array<{ label: string; state: FlowState }> = [
    { label: "Реклама", state: "active" },
    { label: "Заявка", state: "soon" },
    { label: "CRM", state: "soon" },
    { label: "Запись", state: "soon" },
    { label: "Продажа", state: "pending" },
    { label: "Повторный визит", state: "pending" },
    { label: "AI-действие", state: "soon" },
  ];

  const readiness: Array<{ label: string; ready: boolean }> = [
    { label: "CRM подключена", ready: false },
    { label: "Источники заявок", ready: false },
    { label: "WhatsApp", ready: false },
    { label: "Реклама", ready: true },
    { label: "AI-рекомендации", ready: false },
  ];

  return (
    <PageLayout>
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {/* 1. Hero */}
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ ...chipStyle, background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>Negis OS</span>
            <span style={{ ...chipStyle, background: "rgba(37,99,235,0.10)", color: "var(--negis-secondary)" }}>Сегодня · {todayLabel}</span>
            {theme ? <span style={{ ...chipStyle, background: "rgba(124,58,237,0.10)", color: "var(--negis-ai)" }}>Glass AI</span> : null}
          </div>
          <h1 className="mt-3 text-3xl font-black" style={{ color: "var(--negis-text)" }}>AI Control Center</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
            Главная картина клиники: заявки, реклама, записи, продажи и AI-рекомендации.
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-2xl p-3" style={{ background: "rgba(124,58,237,0.06)" }}>
            <Bot size={16} className="mt-0.5" style={{ color: "var(--negis-ai)" }} />
            <p className="text-xs font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              AI помогает находить действия, но важные решения подтверждает пользователь.
            </p>
          </div>
        </header>

        {/* 2. Today metrics */}
        <section>
          <SectionTitle hint="Реальные цифры появятся после подключения CRM и источников заявок.">Сегодня в клинике</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((metric) => (
              <ControlMetricCard key={metric.label} label={metric.label} icon={metric.icon} tone={metric.tone} />
            ))}
          </div>
        </section>

        {/* 3. AI recommendations */}
        <section>
          <SectionTitle hint="Примеры интерфейса. Реальные AI-рекомендации появятся после подключения заявок, CRM и рекламных данных.">
            AI-рекомендации
          </SectionTitle>
          <div className="mb-3 rounded-2xl border p-3 text-xs font-bold" style={{ borderColor: "var(--negis-border)", background: "rgba(124,58,237,0.06)", color: "var(--negis-ai)" }}>
            Пример: реальные рекомендации появятся после подключения заявок, CRM и рекламных данных.
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {recommendations.map((rec) => (
              <AIActionCard key={rec.title} {...rec} />
            ))}
          </div>
        </section>

        {/* 4. Quick actions */}
        <section className="negis-glass p-5">
          <SectionTitle>Быстрые действия</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <QuickActionButton label="Запустить рекламу" icon={Rocket} href="/ads-automation" />
            <QuickActionButton label="Открыть историю запусков" icon={ClipboardList} href="/ads-automation/history" />
            <QuickActionButton label="Добавить заявку" icon={Plus} href="/leads" />
            <QuickActionButton label="Создать задачу" icon={CheckCircle2} href="/tasks" />
            <QuickActionButton label="Открыть контент-студию" icon={Clapperboard} href="/content-studio" />
            <QuickActionButton label="Проверить Meta" icon={ShieldCheck} href="/ads-automation" />
          </div>
        </section>

        {/* 5. Business flow strip */}
        <section className="negis-glass p-5">
          <SectionTitle hint="Стратегическая цепочка Negis OS.">Путь клиента</SectionTitle>
          <div className="flex flex-wrap items-stretch gap-2">
            {flowSteps.map((step, index) => (
              <div key={step.label} className="flex items-center gap-2">
                <BusinessFlowStep label={step.label} state={step.state} />
                {index < flowSteps.length - 1 ? <ArrowRight size={16} style={{ color: "var(--negis-muted)" }} /> : null}
              </div>
            ))}
          </div>
        </section>

        {/* 6 + 7. Ads health + Readiness */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="negis-glass p-5">
            <SectionTitle>Реклама</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ ...chipStyle, background: "rgba(16,185,129,0.12)", color: "var(--negis-success)" }}>Безопасный режим</span>
              <span style={{ ...chipStyle, background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>Instagram</span>
            </div>
            <p className="mt-3 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Последний запуск: <span style={{ color: "var(--negis-text)" }}>нет данных</span>
            </p>
            <p className="mt-2 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Реклама в Negis OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager.
            </p>
            <div className="mt-4">
              <Link href="/ads-automation">
                <button type="button" className="neu-btn-primary justify-center gap-2 px-5 py-2.5 text-sm">
                  <Rocket size={16} />
                  Открыть рекламу
                </button>
              </Link>
            </div>
          </section>

          <section className="negis-glass p-5">
            <SectionTitle hint="Что подключить, чтобы AI Control Center заработал полностью.">Готовность к работе</SectionTitle>
            <div className="space-y-3">
              {readiness.map((item) => (
                <ReadinessRow key={item.label} label={item.label} ready={item.ready} />
              ))}
            </div>
            <p className="mt-4 flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
              <MessageCircle size={14} style={{ color: "var(--negis-primary)" }} />
              Подключение источников заявок и CRM откроет реальные метрики и рекомендации.
            </p>
          </section>
        </div>

        <div className="rounded-2xl border p-4 text-sm font-semibold" style={{ borderColor: "var(--negis-warning)", background: "rgba(245,158,11,0.10)", color: "#8A5A00" }}>
          Полный AI Control Center собирается поэтапно: метрики и AI-рекомендации подключаются по мере готовности данных.
        </div>
      </div>
    </PageLayout>
  );
}
