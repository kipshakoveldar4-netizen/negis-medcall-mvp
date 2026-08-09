import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Eye, EyeOff, Pencil, Plus, RefreshCw, Search, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/contexts/AuthContext";
import { crmErrorMessage, crmFetch } from "@/lib/api";
import { isRealWorkspace, readDemoStorage, readWorkspaceId, workspaceScopedKey, writeDemoStorage } from "@/lib/demoStorage";

// Справочник услуг клиники — прайс, который клиника может править сама.
//
// До миграции 032 «услуга» жила в продукте шестью несвязанными свободными
// строками: её набирали руками на каждой записи, поэтому «Ботокс», «ботокс» и
// «Ботокс лба» были тремя разными услугами в любом подсчёте, цены не было
// нигде, а выручку по услуге посчитать было не из чего.
//
// Экран намеренно не показывает ни одной метрики. Пока оператор не выбрал
// услугу хотя бы в одной записи и продаже, service_id везде пустой, и любая
// цифра «выручка по услуге» была бы сопоставлением строк, выданным за факт.
// Метрики появятся, когда появятся данные, а не раньше.

const DEMO_KEY = "negis_demo_clinic_services";

type ClinicService = {
  id: string;
  name: string;
  category: string;
  basePriceMinor: number | null;
  durationMinutes: number | null;
  description: string;
  sortOrder: number;
  isActive: boolean;
};

type ServiceForm = {
  name: string;
  category: string;
  priceTenge: string;
  durationMinutes: string;
  sortOrder: string;
  description: string;
};

/** Четыре состояния экрана, и все четыре обязаны выглядеть по-разному. */
type ScreenState = "loading" | "ready" | "failed" | "unavailable";

const emptyForm: ServiceForm = {
  name: "",
  category: "",
  priceTenge: "",
  durationMinutes: "",
  sortOrder: "0",
  description: "",
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid var(--negis-border)",
  background: "var(--negis-surface)",
  color: "var(--negis-text)",
  fontSize: 14,
  padding: "11px 13px",
  outline: "none",
};

const labelStyle: CSSProperties = {
  marginBottom: 4,
  display: "block",
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--negis-muted)",
};

function readNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function serviceFromApi(record: Record<string, unknown>): ClinicService {
  return {
    id: readText(record.id),
    name: readText(record.name),
    category: readText(record.category),
    basePriceMinor: readNumberOrNull(record.basePriceMinor ?? record.base_price_minor),
    durationMinutes: readNumberOrNull(record.durationMinutes ?? record.duration_minutes),
    description: readText(record.description),
    sortOrder: readNumberOrNull(record.sortOrder ?? record.sort_order) ?? 0,
    isActive:
      record.isActive === undefined && record.is_active === undefined
        ? true
        : Boolean(record.isActive ?? record.is_active),
  };
}

/**
 * Цена показывается в тенге, а хранится в тиынах — как и суммы продаж.
 * Пустое значение остаётся пустым: «цена не указана» и «бесплатно» — разные
 * факты, и рисовать «0 ₸» напротив неоценённой услуги значит показать клинике
 * цифру, которой она не писала.
 */
function priceInputFromMinor(minor: number | null): string {
  if (minor === null) return "";
  return String(Math.round(minor / 100));
}

function priceMinorFromInput(value: string): number | null {
  const trimmed = value.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function formatPrice(minor: number | null): string {
  if (minor === null) return "—";
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(minor / 100))} ₸`;
}

function formatDuration(minutes: number | null): string {
  return minutes === null ? "—" : `${minutes} мин`;
}

function sortServices(items: ClinicService[]): ClinicService[] {
  // Сервер отдаёт один ORDER BY без тай-брейка, поэтому при равном порядке
  // соседние чтения могли бы вернуть строки в разном порядке.
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"));
}

/** Детали сервера на русском. Оператор не должен читать `name is required`. */
const DETAIL_TEXT: Record<string, string> = {
  "name is required": "Укажите название услуги.",
  "name must be unique within the workspace": "Услуга с таким названием уже есть.",
  "basePriceMinor must be an integer >= 0": "Цена должна быть целым неотрицательным числом.",
  "durationMinutes must be between 1 and 600": "Длительность должна быть от 1 до 600 минут.",
};

function refusalText(status: number, error: string, details: string[]): string {
  const translated = details.map((detail) => DETAIL_TEXT[detail]).filter(Boolean);
  if (translated.length > 0) return translated.join(" ");
  // Заголовок сервера уже по-русски там, где он адресован оператору.
  if (error && /[а-яё]/i.test(error)) return error;
  return crmErrorMessage(status);
}

type ApiEnvelope = {
  success?: boolean;
  mode?: string;
  error?: string;
  details?: string[];
  data?: Record<string, unknown>;
};

async function readEnvelope(response: Response): Promise<ApiEnvelope | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiEnvelope;
  } catch {
    return null;
  }
}

export default function ServicesPage() {
  const { userRole, rolePermissions } = useAuth();
  const [services, setServices] = useState<ClinicService[]>([]);
  const [screen, setScreen] = useState<ScreenState>("loading");
  const [failureText, setFailureText] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState<ServiceForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmHideId, setConfirmHideId] = useState("");

  // Счётчик поколений — тот же приём, что в панели задач: ответ на прошлый
  // запрос не имеет права перезаписать состояние, собранное следующим.
  const generation = useRef(0);

  /**
   * Право на правку. Читает и ресепшн, и врач — форма записи без прайса
   * бесполезна; правит тот, кто отвечает за цены. Когда права нет, кнопок
   * правки на экране просто нет: выключенная кнопка с подсказкой — это
   * приглашение нажать и получить отказ.
   */
  const canManage = useMemo(
    () => userRole === "owner" || userRole === "admin" || userRole === "manager" || Boolean(rolePermissions.admin),
    [rolePermissions.admin, userRole],
  );

  const demoMode = !isRealWorkspace();

  const load = async (options: { quiet?: boolean } = {}) => {
    const current = generation.current + 1;
    generation.current = current;
    if (!options.quiet) setScreen("loading");

    if (demoMode) {
      const stored = readDemoStorage<ClinicService[]>(workspaceScopedKey(DEMO_KEY), []);
      if (generation.current !== current) return;
      setServices(sortServices(stored.map((item) => serviceFromApi(item as unknown as Record<string, unknown>))));
      setScreen("ready");
      return;
    }

    try {
      const workspaceId = readWorkspaceId();
      const response = await crmFetch(`/api/crm/clinic-services?workspaceId=${encodeURIComponent(workspaceId)}`);
      const body = await readEnvelope(response);
      if (generation.current !== current) return;

      if (!response.ok || body?.success !== true) {
        // Пустой список здесь был бы неправдой: «не удалось прочитать» и «услуг
        // нет» — разные ответы, и второй заставил бы клинику заводить прайс
        // заново поверх существующего.
        console.warn("[services] read failed", response.status, body?.error, (body?.details || []).join("; "));
        setFailureText(refusalText(response.status, readText(body?.error), body?.details || []));
        setScreen("failed");
        return;
      }

      if (body.data?.catalogAvailable === false) {
        setServices([]);
        setScreen("unavailable");
        return;
      }

      const raw = body.data?.services ?? body.data?.items;
      const list = Array.isArray(raw) ? raw : [];
      setServices(sortServices(list.map((item) => serviceFromApi(item as Record<string, unknown>))));
      setScreen("ready");
    } catch (error) {
      if (generation.current !== current) return;
      console.warn("[services] read threw", error);
      setFailureText(crmErrorMessage(error));
      setScreen("failed");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistDemo = (next: ClinicService[]) => {
    writeDemoStorage(workspaceScopedKey(DEMO_KEY), next);
    setServices(sortServices(next));
  };

  const openAdd = () => {
    setEditingId("");
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (service: ClinicService) => {
    setEditingId(service.id);
    setForm({
      name: service.name,
      category: service.category,
      priceTenge: priceInputFromMinor(service.basePriceMinor),
      durationMinutes: service.durationMinutes === null ? "" : String(service.durationMinutes),
      sortOrder: String(service.sortOrder),
      description: service.description,
    });
    setFormOpen(true);
  };

  const write = async (method: "POST" | "PATCH", payload: Record<string, unknown>): Promise<boolean> => {
    const workspaceId = readWorkspaceId();
    try {
      const response = await crmFetch("/api/crm/clinic-services", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, workspaceId }),
      });
      const body = await readEnvelope(response);
      if (!response.ok || body?.success !== true) {
        console.warn("[services] write failed", method, response.status, body?.error, (body?.details || []).join("; "));
        toast.error(refusalText(response.status, readText(body?.error), body?.details || []));
        return false;
      }
      return true;
    } catch (error) {
      console.warn("[services] write threw", method, error);
      toast.error(crmErrorMessage(error));
      return false;
    }
  };

  const submitForm = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("Укажите название услуги");
      return;
    }

    const duplicate = services.some(
      (service) => service.id !== editingId && service.isActive && service.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      // Клиентская проверка — удобство; настоящий сторож живёт в уникальном
      // индексе базы и отвечает четырёхсоткой, если два человека сохранят
      // одинаковое название одновременно.
      toast.error("Услуга с таким названием уже есть");
      return;
    }

    const priceMinor = priceMinorFromInput(form.priceTenge);
    if (form.priceTenge.trim() && priceMinor === null) {
      toast.error("Цена должна быть числом");
      return;
    }
    const duration = readNumberOrNull(form.durationMinutes);
    if (form.durationMinutes.trim() && (duration === null || duration <= 0 || duration > 600)) {
      toast.error("Длительность должна быть от 1 до 600 минут");
      return;
    }

    const fields = {
      name,
      category: form.category.trim(),
      basePriceMinor: priceMinor,
      durationMinutes: duration,
      sortOrder: readNumberOrNull(form.sortOrder) ?? 0,
      description: form.description.trim(),
    };

    setSaving(true);
    try {
      if (demoMode) {
        const next = editingId
          ? services.map((service) => (service.id === editingId ? { ...service, ...fields } : service))
          : [...services, { id: `demo-service-${Date.now()}`, isActive: true, ...fields }];
        persistDemo(next);
        setFormOpen(false);
        toast.success(editingId ? "Услуга обновлена" : "Услуга добавлена");
        return;
      }

      const ok = editingId
        ? await write("PATCH", { id: editingId, ...fields })
        : await write("POST", fields);
      if (!ok) return;

      setFormOpen(false);
      toast.success(editingId ? "Услуга обновлена" : "Услуга добавлена");
      await load({ quiet: true });
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (service: ClinicService, isActive: boolean) => {
    if (demoMode) {
      persistDemo(services.map((item) => (item.id === service.id ? { ...item, isActive } : item)));
      toast.success(isActive ? "Услуга возвращена" : "Услуга скрыта");
      return;
    }
    const ok = await write("PATCH", { id: service.id, isActive });
    if (!ok) return;
    toast.success(isActive ? "Услуга возвращена" : "Услуга скрыта");
    await load({ quiet: true });
  };

  const categories = useMemo(
    () => Array.from(new Set(services.map((service) => service.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ru")),
    [services],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return services.filter((service) => {
      if (!showHidden && !service.isActive) return false;
      if (category && service.category !== category) return false;
      if (needle && !service.name.toLowerCase().includes(needle) && !service.category.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [category, search, services, showHidden]);

  const filtersActive = Boolean(search.trim() || category || showHidden);
  const showList = screen === "ready";

  return (
    <PageLayout>
      <div className="space-y-5">
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: "var(--negis-primary)" }}>
                Negis OS · Клиника
              </p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl" style={{ color: "var(--negis-text)" }}>
                Услуги
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                Прайс клиники: названия, цены и длительность. Услуги отсюда подставляются в запись и в продажу.
              </p>
            </div>
            {canManage && showList ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap xl:justify-end">
                <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
                  <Plus size={16} />
                  Добавить услугу
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {demoMode ? (
          <section className="negis-glass p-4 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
            Демо-режим: справочник хранится в этом браузере и не виден коллегам.
          </section>
        ) : null}

        {showList ? (
          <section className="negis-glass p-4 sm:p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative flex-1">
                <Search
                  size={16}
                  aria-hidden
                  style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--negis-muted)" }}
                />
                <input
                  style={{ ...inputStyle, paddingLeft: 42 }}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск по названию или категории"
                  aria-label="Поиск услуги"
                />
              </label>
              <label className="lg:w-56">
                <span className="sr-only">Категория</span>
                <select style={inputStyle} value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Категория">
                  <option value="">Все категории</option>
                  {categories.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="neu-btn justify-center"
                aria-pressed={showHidden}
                onClick={() => setShowHidden((current) => !current)}
              >
                {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                {showHidden ? "Скрытые показаны" : "Показать скрытые"}
              </button>
            </div>
          </section>
        ) : null}

        {screen === "loading" ? (
          <section className="negis-glass flex min-h-40 flex-col items-center justify-center gap-3 p-8 text-center" aria-live="polite">
            <RefreshCw size={20} className="animate-spin" aria-hidden style={{ color: "var(--negis-primary)" }} />
            <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Загружаем данные…</p>
          </section>
        ) : null}

        {screen === "failed" ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-8 text-center" aria-live="polite">
            <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>
              Не удалось загрузить услуги. Это не значит, что их нет.
            </h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              {failureText}
            </p>
            <button type="button" className="neu-btn justify-center" onClick={() => void load()}>
              <RefreshCw size={15} />
              Попробовать снова
            </button>
          </section>
        ) : null}

        {screen === "unavailable" ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-8 text-center">
            <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>
              Справочник услуг ещё не включён для этой клиники
            </h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Записи и продажи работают как раньше: название услуги в них вводится текстом. Когда справочник включат,
              услуги появятся здесь и в форме записи.
            </p>
          </section>
        ) : null}

        {showList && services.length === 0 ? (
          <EmptyState
            icon={Tag}
            title="Услуг пока нет"
            description="Когда вы добавите услуги клиники, они появятся здесь и в форме записи."
            action={
              canManage ? (
                <button type="button" className="neu-btn-primary justify-center" onClick={openAdd}>
                  <Plus size={16} />
                  Добавить услугу
                </button>
              ) : undefined
            }
          />
        ) : null}

        {showList && services.length > 0 && visible.length === 0 ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
              Ничего не найдено. Измените фильтр или поисковый запрос.
            </p>
            {filtersActive ? (
              <button
                type="button"
                className="neu-btn justify-center"
                onClick={() => {
                  setSearch("");
                  setCategory("");
                  setShowHidden(false);
                }}
              >
                Сбросить фильтры
              </button>
            ) : null}
          </section>
        ) : null}

        {showList && visible.length > 0 ? (
          <section className="negis-glass overflow-x-auto p-2 sm:p-3">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr>
                  {["Название услуги", "Категория", "Цена", "Длительность", "Порядок", ""].map((title, index) => (
                    <th
                      key={title || `actions-${index}`}
                      className="px-3 py-2 text-xs font-black uppercase tracking-[0.05em]"
                      style={{ color: "var(--negis-muted)" }}
                    >
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((service) => (
                  <tr key={service.id} style={{ borderTop: "1px solid var(--negis-border)", opacity: service.isActive ? 1 : 0.55 }}>
                    <td className="px-3 py-3">
                      <span className="font-black" style={{ color: "var(--negis-text)" }}>{service.name}</span>
                      {!service.isActive ? (
                        <span className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-black uppercase" style={{ background: "var(--negis-border)", color: "var(--negis-muted)" }}>
                          скрыта
                        </span>
                      ) : null}
                      {service.description ? (
                        <span className="mt-1 block text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                          {service.description}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 font-semibold" style={{ color: "var(--negis-muted)" }}>{service.category || "—"}</td>
                    <td className="px-3 py-3 font-black" style={{ color: "var(--negis-text)" }}>{formatPrice(service.basePriceMinor)}</td>
                    <td className="px-3 py-3 font-semibold" style={{ color: "var(--negis-muted)" }}>{formatDuration(service.durationMinutes)}</td>
                    <td className="px-3 py-3 font-semibold" style={{ color: "var(--negis-muted)" }}>{service.sortOrder}</td>
                    <td className="px-3 py-3">
                      {canManage ? (
                        <div className="flex flex-wrap justify-end gap-2">
                          <button type="button" className="neu-btn px-3 py-2" onClick={() => openEdit(service)} aria-label={`Изменить услугу ${service.name}`}>
                            <Pencil size={14} />
                          </button>
                          {service.isActive ? (
                            <button type="button" className="neu-btn px-3 py-2" onClick={() => setConfirmHideId(service.id)}>
                              Скрыть
                            </button>
                          ) : (
                            <button type="button" className="neu-btn px-3 py-2" onClick={() => void setActive(service, true)}>
                              Вернуть
                            </button>
                          )}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>

      {formOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setFormOpen(false)}>
          <div
            className="negis-glass w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 sm:p-6"
            style={{ background: "var(--negis-surface)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>
                {editingId ? "Изменить услугу" : "Новая услуга"}
              </h2>
              <button type="button" className="neu-btn px-3 py-2" onClick={() => setFormOpen(false)} aria-label="Закрыть">
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span style={labelStyle}>Название услуги</span>
                <input
                  style={inputStyle}
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Консультация косметолога"
                />
              </label>
              <label className="block">
                <span style={labelStyle}>Категория</span>
                <input
                  style={inputStyle}
                  value={form.category}
                  onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                  placeholder="Косметология"
                  list="clinic-service-categories"
                />
                <datalist id="clinic-service-categories">
                  {categories.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span style={labelStyle}>Цена, ₸</span>
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    value={form.priceTenge}
                    onChange={(event) => setForm((current) => ({ ...current, priceTenge: event.target.value }))}
                    placeholder="Оставьте пустым, если цена не фиксирована"
                  />
                </label>
                <label className="block">
                  <span style={labelStyle}>Длительность, мин</span>
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    value={form.durationMinutes}
                    onChange={(event) => setForm((current) => ({ ...current, durationMinutes: event.target.value }))}
                    placeholder="Пусто — 60 минут по умолчанию"
                  />
                </label>
              </div>
              <label className="block">
                <span style={labelStyle}>Порядок в списке</span>
                <input
                  style={inputStyle}
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(event) => setForm((current) => ({ ...current, sortOrder: event.target.value }))}
                />
              </label>
              <label className="block">
                <span style={labelStyle}>Описание</span>
                <textarea
                  style={{ ...inputStyle, minHeight: 84, resize: "vertical" }}
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Что входит в услугу, как проходит приём…"
                />
              </label>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => setFormOpen(false)}>
                Отмена
              </button>
              <button type="button" className="neu-btn-primary justify-center" disabled={saving} onClick={() => void submitForm()}>
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmHideId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.35)" }} onClick={() => setConfirmHideId("")}>
          <div
            className="negis-glass w-full max-w-md p-5 sm:p-6"
            style={{ background: "var(--negis-surface)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>Скрыть услугу из списка?</h2>
            <p className="mt-2 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Прошлые записи и продажи останутся как есть — в них сохранено название на момент визита. Услугу можно
              вернуть в любой момент.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="neu-btn justify-center" onClick={() => setConfirmHideId("")}>
                Отмена
              </button>
              <button
                type="button"
                className="neu-btn-primary justify-center"
                onClick={() => {
                  const service = services.find((item) => item.id === confirmHideId);
                  setConfirmHideId("");
                  if (service) void setActive(service, false);
                }}
              >
                Скрыть
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PageLayout>
  );
}
