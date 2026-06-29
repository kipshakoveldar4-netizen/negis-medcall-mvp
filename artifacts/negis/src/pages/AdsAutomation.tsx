import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Megaphone,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

type ApiResponse<TData = Record<string, unknown>> =
  | {
      success: true;
      mode: string;
      warning?: string;
      data: TData;
    }
  | {
      success: false;
      error: string;
      details?: string[];
      data?: TData;
    };

type LaunchForm = {
  clinicName: string;
  service: string;
  city: string;
  offer: string;
  campaignName: string;
  objective: string;
  dailyBudget: string;
  totalBudget: string;
  currency: string;
  targetAudience: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  landingUrl: string;
  imageUrl: string;
  startDate: string;
  endDate: string;
  statusMode: "PAUSED" | "ACTIVE";
  sourceModule: string;
  sourceId: string;
};

type ConfirmationState = {
  textChecked: boolean;
  budgetChecked: boolean;
  spendUnderstood: boolean;
  clinicAuthority: boolean;
  manualApproval: boolean;
  budgetOverride: boolean;
};

type ComplianceResult = {
  status?: "safe" | "needs_review" | "blocked";
  issues?: Array<{ code?: string; message?: string; severity?: string }>;
  safeText?: string;
};

type LaunchResult = {
  launchId?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaCreativeId?: string;
  metaAdId?: string;
  status?: string;
  metaStatus?: string;
  dryRun?: boolean;
  compliance?: ComplianceResult;
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid #E2E8F0",
  background: "#F8FAFC",
  color: "#0F172A",
  fontSize: 13,
  padding: "11px 12px",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 7,
  fontSize: 11,
  fontWeight: 800,
  color: "#64748B",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const defaultForm: LaunchForm = {
  clinicName: "Concept Clinic",
  service: "Cosmetology consultation",
  city: "Astana",
  offer: "Free consultation and diagnostics",
  campaignName: "Astana Cosmetology Consultation",
  objective: "OUTCOME_LEADS",
  dailyBudget: "20",
  totalBudget: "140",
  currency: "USD",
  targetAudience: "Women 25-55 in Astana interested in cosmetology and skin care",
  primaryText: "Professional cosmetology consultation in Astana. Get an individual care plan after diagnostics.",
  headline: "Cosmetology consultation in Astana",
  description: "Book a consultation with a specialist.",
  cta: "LEARN_MORE",
  landingUrl: "",
  imageUrl: "",
  startDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  endDate: "",
  statusMode: "PAUSED",
  sourceModule: "ads-automation",
  sourceId: "",
};

const confirmationDefaults: ConfirmationState = {
  textChecked: false,
  budgetChecked: false,
  spendUnderstood: false,
  clinicAuthority: false,
  manualApproval: false,
  budgetOverride: false,
};

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readWorkspaceId() {
  return readStored<{ id?: string }>("negis_demo_workspace", { id: "demo-workspace" }).id || "demo-workspace";
}

function applyPrefill(base: LaunchForm): LaunchForm {
  const prefill = readStored<Record<string, unknown>>("negis_ads_automation_prefill", {});
  if (!Object.keys(prefill).length) return base;

  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = prefill[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  };

  return {
    ...base,
    clinicName: text("clinicName") || base.clinicName,
    service: text("service", "niche") || base.service,
    city: text("city") || base.city,
    offer: text("offer", "goal") || base.offer,
    campaignName: text("campaignName", "title") || base.campaignName,
    objective: text("objective") || base.objective,
    dailyBudget: text("dailyBudget", "budget") || base.dailyBudget,
    targetAudience: text("targetAudience", "audience") || base.targetAudience,
    primaryText: text("primaryText", "creativeText", "caption", "script", "hook") || base.primaryText,
    headline: text("headline", "title") || base.headline,
    description: text("description", "goal") || base.description,
    cta: text("cta") || base.cta,
    landingUrl: text("landingUrl", "websiteUrl") || base.landingUrl,
    imageUrl: text("imageUrl") || base.imageUrl,
    sourceModule: text("sourceModule") || base.sourceModule,
    sourceId: text("sourceId", "id") || base.sourceId,
  };
}

async function safeJson<T>(response: globalThis.Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  if (!text.trim()) {
    return { success: false, error: "Empty response", details: ["Сервер вернул пустой ответ."] };
  }

  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return { success: false, error: "Invalid JSON response", details: [text.slice(0, 160)] };
  }
}

async function crmRequest<T>(path: string, init?: globalThis.RequestInit): Promise<Extract<ApiResponse<T>, { success: true }>> {
  const response = await fetch(apiUrl(path), init);
  const body = await safeJson<T>(response);
  if (!response.ok || body.success === false) {
    const details = body.success === false ? body.details?.join(", ") : "";
    throw new Error((body.success === false && body.error) || details || `HTTP ${response.status}`);
  }
  return body as Extract<ApiResponse<T>, { success: true }>;
}

function Field({
  label,
  value,
  onChange,
  textarea,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...inputStyle, minHeight: 112, resize: "vertical" }}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input style={inputStyle} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="rounded-2xl bg-blue-50 p-2.5 text-blue-700">
        <Icon size={18} />
      </div>
      <div>
        <h2 className="text-lg font-black text-[#0F172A]">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-[#64748B]">{subtitle}</p>
      </div>
    </div>
  );
}

export default function AdsAutomation() {
  const [, setLocation] = useLocation();
  const { user, userRole, clinicId } = useAuth();
  const [form, setForm] = useState<LaunchForm>(() => applyPrefill(defaultForm));
  const [confirmations, setConfirmations] = useState<ConfirmationState>(confirmationDefaults);
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [loading, setLoading] = useState<"health" | "validate" | "dry-run" | "launch" | "status" | null>(null);
  const [notice, setNotice] = useState("");
  const [metaSummary, setMetaSummary] = useState<Record<string, unknown> | null>(null);
  const [liveLaunchEnabled, setLiveLaunchEnabled] = useState(() => readStored("negis_meta_live_launch_enabled", false));
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const workspaceId = clinicId || readWorkspaceId();

  useEffect(() => {
    const stored = readStored("negis_meta_live_launch_enabled", false);
    setLiveLaunchEnabled(Boolean(stored));
    void checkHealth();
  }, []);

  const update = (key: keyof LaunchForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const updateConfirmation = (key: keyof ConfirmationState, value: boolean) => setConfirmations((current) => ({ ...current, [key]: value }));

  const budgetWarnings = useMemo(() => {
    const daily = Number(form.dailyBudget);
    const total = Number(form.totalBudget || 0);
    const warnings: string[] = [];
    if (!daily || daily <= 0) warnings.push("Укажите дневной бюджет.");
    if (daily > 50 && !confirmations.budgetOverride) warnings.push("Дневной бюджет выше 50 USD. Нужен admin override.");
    if (total > 300 && !confirmations.budgetOverride) warnings.push("Общий бюджет выше 300 USD. Нужен admin override.");
    return warnings;
  }, [confirmations.budgetOverride, form.dailyBudget, form.totalBudget]);

  const canLaunch = useMemo(() => {
    const base =
      form.campaignName.trim() &&
      form.primaryText.trim() &&
      form.headline.trim() &&
      form.dailyBudget.trim() &&
      (form.landingUrl.trim() || form.imageUrl.trim()) &&
      confirmations.textChecked &&
      confirmations.budgetChecked &&
      confirmations.spendUnderstood &&
      confirmations.clinicAuthority &&
      confirmations.manualApproval &&
      budgetWarnings.length === 0 &&
      compliance?.status !== "blocked";

    if (!base) return false;
    if (form.statusMode === "ACTIVE") {
      return liveLaunchEnabled && ["owner", "admin"].includes(userRole || "") && typedConfirmation.trim() === "ЗАПУСТИТЬ";
    }
    return true;
  }, [budgetWarnings.length, compliance?.status, confirmations, form, liveLaunchEnabled, typedConfirmation, userRole]);

  function buildPayload(dryRun: boolean) {
    return {
      workspaceId,
      launchedBy: user?.user_metadata?.full_name || user?.email || "Negis user",
      launchedByRole: userRole || "owner",
      sourceModule: form.sourceModule,
      sourceId: form.sourceId,
      clinicName: form.clinicName,
      service: form.service,
      city: form.city,
      offer: form.offer,
      campaignName: form.campaignName,
      objective: form.objective,
      statusMode: form.statusMode,
      dailyBudget: Number(form.dailyBudget),
      totalBudget: Number(form.totalBudget || 0),
      currency: form.currency,
      targetAudience: form.targetAudience,
      primaryText: form.primaryText,
      headline: form.headline,
      description: form.description,
      cta: form.cta,
      landingUrl: form.landingUrl,
      imageUrl: form.imageUrl,
      startDate: form.startDate,
      endDate: form.endDate,
      complianceConfirmed: confirmations.textChecked,
      manualApprovalConfirmed: confirmations.manualApproval,
      budgetOverrideConfirmed: confirmations.budgetOverride,
      liveLaunchEnabled,
      activeConfirmation: typedConfirmation.trim(),
      dryRun,
    };
  }

  async function checkHealth() {
    setLoading("health");
    try {
      const body = await crmRequest<{ meta?: Record<string, unknown> }>("/api/crm/health");
      setMetaSummary(body.data?.meta || null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось проверить Meta env.");
    } finally {
      setLoading(null);
    }
  }

  async function validateMeta() {
    setLoading("validate");
    setNotice("");
    try {
      const body = await crmRequest<Record<string, unknown>>("/api/crm/meta-validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, dryRun: true }),
      });
      setNotice(body.data?.configured ? "Meta env выглядят настроенными." : "Meta env проверены в dry-run. Реальный запрос не выполнялся.");
      toast.success("Meta validate выполнен");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Meta validate failed";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  function generatePackage() {
    const city = form.city || "Astana";
    const service = form.service || "consultation";
    const offer = form.offer || "individual diagnostics";
    setForm((current) => ({
      ...current,
      campaignName: current.campaignName || `${city} ${service} leads`,
      primaryText: `Professional ${service} in ${city}. ${offer}. Get an individual recommendation after a specialist consultation.`,
      headline: `${service} in ${city}`,
      description: "Book a consultation and get a clear next step.",
      targetAudience: current.targetAudience || `Women 25-55 in ${city} interested in beauty, wellness and clinic services`,
      cta: "LEARN_MORE",
    }));
    toast.success("AI пакет подготовлен локально");
  }

  async function dryRunLaunch() {
    setLoading("dry-run");
    setNotice("");
    try {
      const payload = {
        ...buildPayload(true),
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
      };
      const body = await crmRequest<LaunchResult>("/api/crm/meta-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setLaunchResult(body.data || null);
      setCompliance(body.data?.compliance || null);
      setNotice(body.warning || "Dry-run прошел: реальный Meta API не вызывался.");
      toast.success("Dry-run готов");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dry-run failed";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  async function launchCampaign() {
    if (!canLaunch) {
      toast.error("Проверьте поля и подтверждения перед запуском");
      return;
    }

    setLoading("launch");
    setNotice("");
    try {
      const body = await crmRequest<LaunchResult>("/api/crm/meta-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(false)),
      });
      setLaunchResult(body.data || null);
      setCompliance(body.data?.compliance || null);
      setNotice(body.warning || "Кампания создана в Meta.");
      toast.success(form.statusMode === "ACTIVE" ? "Реклама запущена" : "Кампания создана в PAUSED");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Meta launch failed";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  async function checkStatus() {
    if (!launchResult?.metaCampaignId) {
      toast.error("Сначала создайте кампанию или dry-run");
      return;
    }
    setLoading("status");
    try {
      const body = await crmRequest<Record<string, unknown>>(`/api/crm/meta-status?campaignId=${encodeURIComponent(launchResult.metaCampaignId)}`);
      setNotice(`Status checked: ${JSON.stringify(body.data).slice(0, 220)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Meta status failed";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  const adsManagerUrl = useMemo(() => {
    const accountId = String(metaSummary?.adAccountId || "").replace(/^act_/, "");
    return accountId ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId}` : "https://adsmanager.facebook.com/";
  }, [metaSummary]);

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-700">Meta Marketing API</p>
            <h1 className="mt-2 text-3xl font-black text-[#0F172A]">AI запуск рекламы</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#64748B]">
              Создание campaign, ad set, creative и ad в Meta. По умолчанию реклама создается в статусе PAUSED, ACTIVE требует отдельного разрешения и ручного подтверждения.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="neu-btn justify-center" onClick={() => setLocation("/ads")}>
              <Megaphone size={16} />
              Вернуться в рекламу
            </button>
            <button type="button" className="neu-btn-primary justify-center" disabled={loading === "validate"} onClick={validateMeta}>
              {loading === "validate" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
              Проверить Meta
            </button>
          </div>
        </div>

        {notice ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
            {notice}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="neu-card p-6">
            <SectionTitle icon={Target} title="Campaign brief" subtitle="Поля, которые уйдут на сервер для создания Meta campaign/ad set/creative/ad." />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Клиника" value={form.clinicName} onChange={(value) => update("clinicName", value)} />
              <Field label="Услуга" value={form.service} onChange={(value) => update("service", value)} />
              <Field label="Город" value={form.city} onChange={(value) => update("city", value)} />
              <Field label="Оффер" value={form.offer} onChange={(value) => update("offer", value)} />
              <Field label="Campaign name" value={form.campaignName} onChange={(value) => update("campaignName", value)} />
              <Field label="Objective" value={form.objective} onChange={(value) => update("objective", value)} />
              <Field label="Daily budget" type="number" value={form.dailyBudget} onChange={(value) => update("dailyBudget", value)} />
              <Field label="Total budget" type="number" value={form.totalBudget} onChange={(value) => update("totalBudget", value)} />
              <Field label="Currency" value={form.currency} onChange={(value) => update("currency", value)} />
              <Field label="Start date" type="date" value={form.startDate} onChange={(value) => update("startDate", value)} />
              <Field label="End date" type="date" value={form.endDate} onChange={(value) => update("endDate", value)} />
              <label>
                <span style={labelStyle}>Status mode</span>
                <select style={inputStyle} value={form.statusMode} onChange={(event) => update("statusMode", event.target.value as LaunchForm["statusMode"])}>
                  <option value="PAUSED">PAUSED - безопасный запуск</option>
                  <option value="ACTIVE">ACTIVE - сразу тратить бюджет</option>
                </select>
              </label>
              <div className="md:col-span-2">
                <Field label="Аудитория" value={form.targetAudience} onChange={(value) => update("targetAudience", value)} textarea />
              </div>
              <div className="md:col-span-2">
                <Field label="Landing URL" value={form.landingUrl} onChange={(value) => update("landingUrl", value)} placeholder="https://..." />
              </div>
              <div className="md:col-span-2">
                <Field label="Image URL" value={form.imageUrl} onChange={(value) => update("imageUrl", value)} placeholder="https://..." />
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <section className="neu-card p-6">
              <SectionTitle icon={Sparkles} title="AI generate package" subtitle="Локальный MVP-пакет из текущего брифа." />
              <button type="button" className="neu-btn-primary w-full justify-center" onClick={generatePackage}>
                <Sparkles size={16} />
                Сгенерировать пакет
              </button>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="neu-sm p-3">
                  <b>Hook:</b> {form.headline || "Заполните headline"}
                </div>
                <div className="neu-sm p-3">
                  <b>Budget plan:</b> {form.dailyBudget || 0} {form.currency}/day, {form.statusMode}
                </div>
                <div className="neu-sm p-3">
                  <b>Audience:</b> {form.targetAudience}
                </div>
              </div>
            </section>

            <section className="neu-card p-6">
              <SectionTitle icon={ShieldCheck} title="Compliance check" subtitle="Проверка выполняется сервером через dry-run без вызова Meta API." />
              <button type="button" className="neu-btn-primary w-full justify-center" disabled={loading === "dry-run"} onClick={dryRunLaunch}>
                {loading === "dry-run" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
                Dry-run и compliance
              </button>
              {compliance ? (
                <div className="mt-4 space-y-3">
                  <div
                    className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
                      compliance.status === "blocked"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : compliance.status === "needs_review"
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    Статус: {compliance.status || "unknown"}
                  </div>
                  {compliance.issues?.length ? (
                    <ul className="space-y-2 text-sm text-[#475569]">
                      {compliance.issues.map((issue) => (
                        <li key={issue.code || issue.message} className="rounded-xl bg-white/70 p-3">
                          {issue.message || issue.code}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {compliance.safeText ? (
                    <button type="button" className="neu-btn w-full justify-center" onClick={() => update("primaryText", compliance.safeText || form.primaryText)}>
                      Принять безопасную версию текста
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          </aside>
        </div>

        <section className="neu-card p-6">
          <SectionTitle icon={Megaphone} title="Creative" subtitle="Текст объявления, headline, description и CTA для object_story_spec/link_data." />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Primary text" value={form.primaryText} onChange={(value) => update("primaryText", value)} textarea />
            </div>
            <Field label="Headline" value={form.headline} onChange={(value) => update("headline", value)} />
            <Field label="Description" value={form.description} onChange={(value) => update("description", value)} />
            <Field label="CTA" value={form.cta} onChange={(value) => update("cta", value)} />
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="neu-card p-6">
            <SectionTitle icon={Rocket} title="Meta launch preview" subtitle="Секреты не отображаются. Token и app secret остаются только на сервере." />
            <div className="grid gap-3 text-sm">
              {[
                ["Campaign", form.campaignName],
                ["Ad Set", `${form.city} · ${form.targetAudience}`],
                ["Creative", form.headline],
                ["Ad", `${form.campaignName} - Ad`],
                ["Budget", `${form.dailyBudget} ${form.currency}/day · total ${form.totalBudget || "auto"}`],
                ["Status mode", form.statusMode],
                ["Ad Account ID", String(metaSummary?.adAccountId || "env/backend")],
                ["Page ID", String(metaSummary?.pageId || "env/backend")],
                ["Instagram Actor ID", String(metaSummary?.instagramActorId || "env/backend")],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1 rounded-2xl border border-[#E2E8F0] bg-white/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-bold text-[#64748B]">{label}</span>
                  <span className="break-all text-[#0F172A]">{value}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="neu-card p-6">
            <SectionTitle icon={AlertTriangle} title="Confirmation block" subtitle="Без этих подтверждений реальный запуск не пройдет." />
            <div className="space-y-3">
              {[
                ["textChecked", "Я проверил текст объявления"],
                ["budgetChecked", "Я проверил бюджет"],
                ["spendUnderstood", "Я понимаю, что реклама может тратить деньги"],
                ["clinicAuthority", "Я подтверждаю запуск от имени клиники"],
                ["manualApproval", "Я согласен с manual approval"],
                ["budgetOverride", "Admin override для бюджета выше лимита"],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-3 rounded-2xl border border-[#E2E8F0] bg-white/70 px-4 py-3 text-sm font-semibold text-[#334155]">
                  <input
                    type="checkbox"
                    checked={Boolean(confirmations[key as keyof ConfirmationState])}
                    onChange={(event) => updateConfirmation(key as keyof ConfirmationState, event.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {budgetWarnings.length ? (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                {budgetWarnings.join(" ")}
              </div>
            ) : null}
            {form.statusMode === "ACTIVE" ? (
              <div className="mt-4">
                <Field label="Введите ЗАПУСТИТЬ для подтверждения ACTIVE" value={typedConfirmation} onChange={setTypedConfirmation} />
                {!liveLaunchEnabled ? <p className="mt-2 text-sm font-semibold text-red-600">Live launch выключен в Admin Center.</p> : null}
              </div>
            ) : null}
            <button
              type="button"
              className="neu-btn-primary mt-5 w-full justify-center"
              disabled={!canLaunch || loading === "launch"}
              onClick={launchCampaign}
            >
              {loading === "launch" ? <Loader2 className="animate-spin" size={16} /> : <Rocket size={16} />}
              {form.statusMode === "ACTIVE" ? "Запустить рекламу в Meta" : "Создать в Meta в статусе PAUSED"}
            </button>
          </section>
        </div>

        {launchResult ? (
          <section className="neu-card p-6">
            <SectionTitle icon={CheckCircle2} title="Result" subtitle={launchResult.dryRun ? "Dry-run result: Meta API не вызывался." : "Meta launch response сохранен для аудита."} />
            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["Launch ID", launchResult.launchId],
                ["Meta Campaign ID", launchResult.metaCampaignId],
                ["Ad Set ID", launchResult.metaAdSetId],
                ["Creative ID", launchResult.metaCreativeId],
                ["Ad ID", launchResult.metaAdId],
                ["Status", launchResult.metaStatus || launchResult.status],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-[#E2E8F0] bg-white/70 px-4 py-3">
                  <p className="text-xs font-bold uppercase text-[#64748B]">{label}</p>
                  <p className="mt-1 break-all font-mono text-sm text-[#0F172A]">{value || "-"}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <a className="neu-btn justify-center" href={adsManagerUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Открыть Ads Manager
              </a>
              <button type="button" className="neu-btn-primary justify-center" disabled={loading === "status"} onClick={checkStatus}>
                {loading === "status" ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
                Проверить статус
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </PageLayout>
  );
}
