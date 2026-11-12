import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Users } from "lucide-react";

import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { termsFor } from "../../../../lib/vertical/terms";

// База клиентов по мастерам.
//
// Правило владельца салона: «каждый мастер свою базу видит без номеров, а админы
// — базу всех мастеров с номерами». Экран один на обе роли намеренно: это один и
// тот же вопрос «чей это клиент», и разводить его по двум страницам значило бы
// поддерживать два списка, которые разъедутся на первой же правке.
//
// Что видит мастер: своих клиентов, число визитов, последний визит. Телефона
// нет — его срезает сервер, а не эта страница. Экран лишь честно об этом
// говорит, чтобы человек не думал, что номер потерялся.
//
// Что видит администратор: тех же людей по каждому мастеру, с номерами, с
// поиском и с выбором мастера — это и есть «кто чей клиент», ради которого
// владелец просил фильтр для рассылок.

interface BaseClient {
  id: string;
  fullName: string;
  phone: string;
  whatsapp: string;
  visits: number;
  lastVisitAt: string;
  doctorId: string;
  doctorName: string;
}

interface DoctorOption {
  id: string;
  fullName: string;
  specialty: string;
}

function formatVisitDate(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** «12 визитов» / «1 визит» / «2 визита» — иначе строка читается как машинная. */
function formatVisits(count: number): string {
  if (count <= 0) return "визитов нет";
  const tail = count % 100 >= 11 && count % 100 <= 14 ? 0 : count % 10;
  if (tail === 1) return `${count} визит`;
  if (tail >= 2 && tail <= 4) return `${count} визита`;
  return `${count} визитов`;
}

export default function ClientBasePage() {
  const { clinicId, userRole, vertical, rolePermissions } = useAuth();
  const terms = termsFor(vertical);

  const seesEveryone = Boolean(rolePermissions.crm);
  const [items, setItems] = useState<BaseClient[]>([]);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [state, setState] = useState<{ contactsHidden: boolean; truncated: boolean; reason: string; migration: string }>({
    contactsHidden: false,
    truncated: false,
    reason: "",
    migration: "",
  });

  const load = useCallback(async () => {
    if (!clinicId) return;
    setLoaded(false);
    setLoadError("");
    try {
      const query = new URLSearchParams({ workspaceId: clinicId });
      if (seesEveryone && doctorFilter !== "all") query.set("doctorId", doctorFilter);
      const response = await crmFetch(`/api/crm/my-clients?${query.toString()}`);
      const payload = (await response.json()) as {
        success?: boolean;
        items?: BaseClient[];
        truncated?: boolean;
        contactsHidden?: boolean;
        reason?: string;
        migration?: string;
        error?: string;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Не удалось загрузить базу клиентов");
      }
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setState({
        contactsHidden: Boolean(payload.contactsHidden),
        truncated: Boolean(payload.truncated),
        reason: payload.reason ?? "",
        migration: payload.migration ?? "",
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить базу клиентов");
    } finally {
      setLoaded(true);
    }
  }, [clinicId, doctorFilter, seesEveryone]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Список мастеров нужен только тому, кто может смотреть чужие базы.
    if (!seesEveryone || !clinicId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await crmFetch(`/api/crm/clinic-doctors?workspaceId=${encodeURIComponent(clinicId)}`);
        const payload = (await response.json()) as { items?: Array<DoctorOption & { isActive?: boolean }> };
        if (cancelled) return;
        setDoctors((payload.items ?? []).filter((doctor) => doctor.isActive !== false));
      } catch {
        // Не смогли — фильтр просто не появится. База при этом читается целиком,
        // и это честнее, чем пустой выпадающий список без объяснения.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clinicId, seesEveryone]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.fullName.toLowerCase().includes(needle) ||
        item.phone.toLowerCase().includes(needle) ||
        item.doctorName.toLowerCase().includes(needle),
    );
  }, [items, search]);

  const byDoctor = useMemo(() => {
    const groups = new Map<string, BaseClient[]>();
    for (const item of visible) {
      const key = item.doctorName || "Без мастера";
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((left, right) => right[1].length - left[1].length);
  }, [visible]);

  return (
    <PageLayout>
      <header className="negis-glass-hero p-5 sm:p-6">
        <h1 className="text-xl font-black text-[#0F172A] sm:text-2xl">
          {seesEveryone ? "База клиентов по мастерам" : "Мои клиенты"}
        </h1>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-[#475569]">
          {seesEveryone
            ? `Кто чей клиент: сколько раз приходил и когда был последний раз. По этому списку удобно делать рассылки.`
            : `Люди, которые ходят именно к вам. Телефоны видят администраторы ${terms.orgGenitive} — это правило ${terms.orgGenitive}, а не сбой.`}
        </p>
      </header>

      {loadError ? (
        <section className="negis-glass mt-5 p-4" style={{ borderLeft: "4px solid #dc2626" }} aria-live="assertive">
          <p className="text-sm font-black" style={{ color: "#b91c1c" }}>
            Не удалось загрузить базу клиентов
          </p>
          <p className="mt-1 text-sm font-semibold text-[#475569]">
            Это сбой связи, а не пустая база. Не заводите клиентов заново — они на месте.
          </p>
          <button type="button" className="neu-btn mt-3 px-4 py-2 text-sm" onClick={() => void load()}>
            Попробовать снова
          </button>
        </section>
      ) : null}

      {state.reason === "unlinked" ? (
        <section className="negis-glass mt-5 p-4" style={{ borderLeft: "4px solid #f59e0b" }}>
          <p className="text-sm font-black text-[#0F172A]">Ваша карточка не связана с этим входом</p>
          <p className="mt-1 text-sm font-semibold text-[#475569]">
            Поэтому система пока не знает, какие клиенты ваши. Попросите администратора связать карточку — после этого
            список появится сам.
          </p>
        </section>
      ) : null}

      {state.migration ? (
        <section className="negis-glass mt-5 p-4">
          <p className="text-sm font-black text-[#0F172A]">База по мастерам ещё не включена</p>
          <p className="mt-1 text-sm font-semibold text-[#475569]">
            Нужна миграция {state.migration}. До неё связи «клиент — мастер» в базе нет, и показывать нечего.
          </p>
        </section>
      ) : null}

      <section className="negis-glass mt-5 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]" />
            <input
              className="neu-input w-full pl-9"
              placeholder={seesEveryone ? "Имя, номер или мастер" : "Имя клиента"}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {seesEveryone && doctors.length > 0 ? (
            <select className="neu-input" value={doctorFilter} onChange={(event) => setDoctorFilter(event.target.value)}>
              <option value="all">Все мастера</option>
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                  {doctor.specialty ? ` · ${doctor.specialty}` : ""}
                </option>
              ))}
            </select>
          ) : null}
          <span className="text-sm font-bold text-[#64748B]">
            {loaded ? `${visible.length} из ${items.length}` : "Загружаем…"}
          </span>
        </div>

        {state.contactsHidden ? (
          <p className="mt-3 text-xs font-bold text-[#94A3B8]">
            Номера скрыты: их видят владелец и администраторы.
          </p>
        ) : null}
        {state.truncated ? (
          <p className="mt-2 text-xs font-black" style={{ color: "#b45309" }}>
            Показаны не все: список обрезан. Сузьте выбор мастером или поиском, иначе часть базы останется невидимой.
          </p>
        ) : null}
      </section>

      {loaded && !loadError && items.length === 0 && !state.reason && !state.migration ? (
        <section className="negis-glass mt-5 flex flex-col items-center p-8 text-center">
          <Users size={28} className="text-[#94A3B8]" />
          <p className="mt-3 text-sm font-black text-[#0F172A]">Пока никого</p>
          <p className="mt-1 text-sm font-semibold text-[#475569]">
            {seesEveryone
              ? "Ни один клиент ещё не привязан к мастеру."
              : "К вам ещё никто не записан — или клиентов пока не привязали к вашей карточке."}
          </p>
        </section>
      ) : null}

      {loaded && !loadError && visible.length > 0 ? (
        <div className="mt-5 space-y-4">
          {(seesEveryone ? byDoctor : [["", visible] as [string, BaseClient[]]]).map(([doctorName, list]) => (
            <section key={doctorName || "own"} className="negis-glass p-4">
              {doctorName ? (
                <p className="text-sm font-black text-[#0F172A]">
                  {doctorName}
                  <span className="ml-2 text-xs font-bold text-[#64748B]">{list.length}</span>
                </p>
              ) : null}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="text-xs font-black uppercase tracking-[0.1em] text-[#94A3B8]">
                      <th className="px-2 py-2">Клиент</th>
                      {state.contactsHidden ? null : <th className="px-2 py-2">Телефон</th>}
                      <th className="px-2 py-2">Визиты</th>
                      <th className="px-2 py-2">Последний раз</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((item) => (
                      <tr key={`${item.doctorId}:${item.id}`} style={{ borderTop: "1px solid var(--negis-border)" }}>
                        <td className="px-2 py-2 font-black text-[#0F172A]">{item.fullName}</td>
                        {state.contactsHidden ? null : (
                          <td className="px-2 py-2 font-bold tabular-nums text-[#475569]">
                            {item.phone ? <a href={`tel:${item.phone}`}>{item.phone}</a> : "—"}
                          </td>
                        )}
                        <td className="px-2 py-2 font-semibold text-[#475569]">{formatVisits(item.visits)}</td>
                        <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">
                          {formatVisitDate(item.lastVisitAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </PageLayout>
  );
}
