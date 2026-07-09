import { Link } from "wouter";
import {
  Inbox,
  Megaphone,
  RefreshCw,
  Rocket,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { defaultThemePresetId, getThemePreset } from "@/lib/themePresets";

// D3 placeholder. The full AI Control Center (real metrics, AI actions) is a later
// design task; this screen only establishes the route and the layout language.
// Visuals follow the default theme (Glass Morphic Medical AI) via --negis-* tokens.
type PreviewCard = {
  label: string;
  hint: string;
  icon: LucideIcon;
  accent: "primary" | "ai";
};

const previewCards: PreviewCard[] = [
  { label: "Заявки сегодня", hint: "Сколько новых заявок пришло за день", icon: Inbox, accent: "primary" },
  { label: "Необработанные лиды", hint: "Кого ещё не взяли в работу", icon: Users, accent: "primary" },
  { label: "Реклама требует внимания", hint: "Кампании и креативы, где нужен шаг", icon: Megaphone, accent: "primary" },
  { label: "Пациенты для повторного визита", hint: "Кого стоит вернуть в клинику", icon: RefreshCw, accent: "primary" },
  { label: "AI подготовил действия", hint: "Готовые рекомендации к запуску", icon: Sparkles, accent: "ai" },
];

export default function AiControlCenter() {
  const theme = getThemePreset(defaultThemePresetId);

  return (
    <PageLayout>
      <div className="mx-auto max-w-6xl space-y-7 px-4 py-6 sm:px-6">
        <header className="negis-glass-hero flex flex-col gap-2 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-black uppercase tracking-[0.16em]" style={{ color: "var(--negis-primary)" }}>Negis OS</p>
            {theme ? (
              <span
                className="rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]"
                style={{ background: "rgba(124,58,237,0.10)", color: "var(--negis-ai)" }}
              >
                Тема: {theme.name}
              </span>
            ) : null}
          </div>
          <h1 className="text-3xl font-black" style={{ color: "var(--negis-text)" }}>AI Control Center</h1>
          <p className="max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
            Главный экран Negis OS: заявки, реклама, продажи, записи и AI-рекомендации в одном месте.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {previewCards.map(({ label, hint, icon: Icon, accent }) => {
            const accentColor = accent === "ai" ? "var(--negis-ai)" : "var(--negis-primary)";
            const accentBg = accent === "ai" ? "rgba(124,58,237,0.10)" : "var(--negis-primary-soft)";
            return (
              <div key={label} className="negis-glass p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ background: accentBg, color: accentColor }}>
                    <Icon size={20} />
                  </div>
                  <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{label}</p>
                </div>
                <p className="mt-4 text-3xl font-black" style={{ color: "var(--negis-text)" }}>—</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>{hint}</p>
              </div>
            );
          })}
        </section>

        <section className="negis-glass p-5">
          <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>Быстрые действия</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link href="/ads-automation">
              <button type="button" className="neu-btn-primary inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm sm:w-auto">
                <Rocket size={16} />
                Запустить рекламу
              </button>
            </Link>
            <button
              type="button"
              className="neu-btn inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm opacity-60 sm:w-auto"
              disabled
              title="Появится на следующем этапе"
            >
              <Inbox size={16} />
              Открыть заявки
            </button>
            <button
              type="button"
              className="neu-btn inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm opacity-60 sm:w-auto"
              disabled
              title="Появится на следующем этапе"
            >
              <Sparkles size={16} />
              Посмотреть рекомендации
            </button>
          </div>
        </section>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          Полный AI Control Center будет собран следующим этапом.
        </div>
      </div>
    </PageLayout>
  );
}
