import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PageLayout } from "@/components/layout/PageLayout";
import { crmFetch } from "@/lib/api";
import { readWorkspaceId } from "@/lib/demoStorage";
import {
  APP_SETUP_LABEL,
  APP_STATE_LABEL,
  appsByCategory,
  isRequested,
  type MarketplaceApp,
} from "../../../../lib/marketplace/catalogue";

// Маркет приложений.
//
// На этом маршруте раньше стояла сетка из четырёх карточек с захардкоженными
// числами — 300 USD, 24 лида, CPL 12.5, ROMI +218%, — не связанными ни с одним
// источником данных. Одна из карточек вела на маршрут, удалённый из продукта.
//
// Здесь ровно наоборот: каталог перечисляет то, что в продукте действительно
// есть, состояние подключения читается из integration-statuses этой клиники, а
// у каждой карточки написано, чего приложение НЕ делает. Половина интеграции,
// поданная как целая, — самый дешёвый способ обмануть на демонстрации.

type StatusRow = { provider?: string; status?: string; masked_identifier?: string; last_checked_at?: string };

function StateBadge({ app }: { app: MarketplaceApp }) {
  const tone =
    app.state === "live"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : app.state === "inbound_only"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-[#D8E4EC] bg-white/70 text-[#475569]";
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-black ${tone}`}>{APP_STATE_LABEL[app.state]}</span>
  );
}

/** Заголовок страницы: PageLayout принимает только содержимое. */
function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="negis-glass-hero p-5 sm:p-6">
      <h1 className="text-xl font-black text-[#0F172A] sm:text-2xl">{title}</h1>
      {subtitle ? <p className="mt-2 text-sm font-semibold leading-relaxed text-[#475569]">{subtitle}</p> : null}
    </header>
  );
}

export default function MarketplacePage() {
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Чтение состояния доступно только владельцу и администратору клиники.
  // Маркетолог страницу видит, а строки — нет, и это не «заявок нет».
  const [statusesReadable, setStatusesReadable] = useState(true);
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const workspaceId = readWorkspaceId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await crmFetch(`/api/crm/integration-statuses?workspaceId=${encodeURIComponent(workspaceId)}`);
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        const items = Array.isArray(body?.data?.items) ? body.data.items : [];
        if (!cancelled) setStatuses(items as StatusRow[]);
      } catch {
        // Отказ чтения — это НЕ «заявок нет». Каталог показывается, а про
        // заявки экран честно говорит, что не знает.
        if (!cancelled) {
          setStatuses([]);
          setStatusesReadable(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const groups = useMemo(() => appsByCategory(), []);

  async function requestApp(app: MarketplaceApp) {
    setRequested((current) => ({ ...current, [app.id]: true }));
    try {
      const response = await crmFetch(`/api/crm/integration-statuses?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Ключ заявки отдельный, а не provider приложения.
          //
          // POST этого ресурса — upsert по паре (workspace_id, provider), и он
          // перезаписывает строку целиком: masked_identifier и last_error
          // обнуляются. Сегодня заявку можно оставить только у приложений без
          // provider, поэтому затирать нечего, — но стоит однажды дописать
          // provider «планируемому» приложению, и заявка сотрёт настоящее
          // состояние подключения. Заявка и подключение — разные вещи, и
          // жить им в разных строках.
          provider: `request:${app.id}`,
          status: "requested",
          metadata: { app: app.id, title: app.title },
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      toast.success("Заявка записана — свяжемся по подключению");
    } catch {
      setRequested((current) => ({ ...current, [app.id]: false }));
      toast.error("Не удалось записать заявку");
    }
  }

  return (
    <PageLayout>
      <PageHeader title="Маркет приложений" subtitle="Что клиника может подключить к Negis. У каждой карточки честное состояние: что работает, что работает частично, чего пока нет." />
      {loading ? (
        <div className="flex items-center gap-2 text-sm font-semibold text-[#64748B]">
          <Loader2 className="animate-spin" size={16} /> Читаю подключения…
        </div>
      ) : null}

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.category}>
            <h2 className="text-lg font-black text-[#0F172A]">{group.title}</h2>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {group.apps.map((app) => {
                // Заявка переживает перезагрузку: она лежит строкой в базе.
                // Пока строки не прочитаны, полагаемся на память вкладки.
                const alreadyRequested = Boolean(requested[app.id]) || isRequested(app, statuses);
                return (
                  <article key={app.id} className="neu-card p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-base font-black text-[#0F172A]">{app.title}</h3>
                        <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#94A3B8]">{app.vendor}</p>
                      </div>
                      <StateBadge app={app} />
                    </div>

                    <p className="mt-3 text-sm font-semibold leading-relaxed text-[#334155]">{app.summary}</p>

                    {/*
                      Ограничения — обязательная часть карточки, а не мелкий шрифт.
                      Клиника, узнавшая про «отвечать нельзя» после подключения,
                      имеет полное право считать, что её ввели в заблуждение.
                    */}
                    <ul className="mt-3 space-y-1 text-xs font-semibold text-[#64748B]">
                      {app.limits.map((limit) => (
                        <li key={limit}>— {limit}</li>
                      ))}
                    </ul>

                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="text-xs font-black text-[#475569]">{APP_SETUP_LABEL[app.setup]}</span>
                      {app.state === "planned" ? (
                        <button
                          type="button"
                          className="neu-btn justify-center text-sm"
                          disabled={alreadyRequested}
                          onClick={() => void requestApp(app)}
                        >
                          {alreadyRequested ? "Заявка оставлена" : "Оставить заявку"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/*
        Это ограничение продукта, а не текст для успокоения. Секреты сегодня —
        одна платформенная переменная на всех клиентов, а привязка канала к
        клинике делается вручную. Кнопки «Подключить» поэтому нет ни у одной
        карточки, и написать её, не сделав хранение ключей по клиникам, значило
        бы обещать работу, которой не сделано.
      */}
      <p className="mt-8 rounded-2xl border border-[#D8E4EC] bg-white/65 p-4 text-sm font-semibold leading-relaxed text-[#475569]">
        Подключение сейчас делается вместе с нами: ключи доступа хранятся на стороне платформы, и канал привязывается
        к клинике при настройке. Самостоятельного подключения из интерфейса пока нет ни у одного приложения.
        {statusesReadable ? null : " Оставленные заявки видны владельцу и администратору клиники."}
      </p>
    </PageLayout>
  );
}
