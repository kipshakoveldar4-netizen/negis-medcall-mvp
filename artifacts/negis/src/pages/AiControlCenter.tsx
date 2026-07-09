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

// D3 placeholder. The full AI Control Center (real metrics, AI actions) is a later
// design task; this screen only establishes the route and the layout language.
type PreviewCard = {
  label: string;
  hint: string;
  icon: LucideIcon;
};

const previewCards: PreviewCard[] = [
  { label: "Заявки сегодня", hint: "Сколько новых заявок пришло за день", icon: Inbox },
  { label: "Необработанные лиды", hint: "Кого ещё не взяли в работу", icon: Users },
  { label: "Реклама требует внимания", hint: "Кампании и креативы, где нужен шаг", icon: Megaphone },
  { label: "Пациенты для повторного визита", hint: "Кого стоит вернуть в клинику", icon: RefreshCw },
  { label: "AI подготовил действия", hint: "Готовые рекомендации к запуску", icon: Sparkles },
];

export default function AiControlCenter() {
  return (
    <PageLayout>
      <div className="mx-auto max-w-6xl space-y-7 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Negis OS</p>
          <h1 className="text-3xl font-black text-[#0F172A]">AI Control Center</h1>
          <p className="max-w-3xl text-sm leading-relaxed text-[#64748B]">
            Главный экран Negis OS: заявки, реклама, продажи, записи и AI-рекомендации в одном месте.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {previewCards.map(({ label, hint, icon: Icon }) => (
            <div key={label} className="rounded-[24px] border border-[#E2ECF3] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#E6F7F3] text-[#0D9488]">
                  <Icon size={20} />
                </div>
                <p className="text-sm font-black text-[#0F172A]">{label}</p>
              </div>
              <p className="mt-4 text-3xl font-black text-[#0F172A]">—</p>
              <p className="mt-1 text-sm font-semibold text-[#64748B]">{hint}</p>
            </div>
          ))}
        </section>

        <section className="rounded-[24px] border border-[#E2ECF3] bg-white p-5">
          <p className="text-sm font-black text-[#0F172A]">Быстрые действия</p>
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
