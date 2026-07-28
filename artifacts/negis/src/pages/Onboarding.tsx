import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, Inbox } from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl, crmFetch } from "@/lib/api";
import { readWorkspaceId } from "@/lib/demoStorage";

// Medina OS Commercial-2 — clinic onboarding checklist.
//
// Every step status is DERIVED from real workspace data via the same existing
// endpoints the rest of the product uses. Opening this page never marks
// anything complete; there is no browser-only "done" flag and no fake
// persistence. Advertising is optional and campaigns stay PAUSED.

type StepState = "loading" | "done" | "todo" | "unknown";

type SetupStep = {
  key: string;
  title: string;
  explanation: string;
  state: StepState;
  actionLabel: string;
  actionHref: string;
  optional?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchJson(path: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await crmFetch(path);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { ok: response.ok && body.success === true, body };
  } catch {
    return { ok: false, body: {} };
  }
}

function listFrom(body: Record<string, unknown>, ...keys: string[]): unknown[] {
  const data = asRecord(body.data);
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return Array.isArray(data.items) ? data.items : [];
}

function StepRow({ step, index }: { step: SetupStep; index: number }) {
  const done = step.state === "done";
  const unknown = step.state === "unknown";
  return (
    <li aria-current={!done && !unknown && step.state !== "loading" ? "step" : undefined}>
      <div className="neu flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 shrink-0" style={{ color: done ? "var(--ng-success)" : "var(--ng-muted)" }}>
            {done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--ng-text)" }}>
              {index}. {step.title}
              {step.optional ? <span className="ml-2 text-xs font-medium" style={{ color: "var(--ng-muted)" }}>необязательно</span> : null}
            </p>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--ng-muted)" }}>{step.explanation}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {step.state === "loading" ? (
            <StatusBadge tone="neutral">Проверяем…</StatusBadge>
          ) : done ? (
            <StatusBadge tone="success">Готово</StatusBadge>
          ) : unknown ? (
            <StatusBadge tone="neutral">Не удалось проверить</StatusBadge>
          ) : (
            <StatusBadge tone={step.optional ? "neutral" : "warning"}>Не выполнено</StatusBadge>
          )}
          <Link href={step.actionHref}>
            <span className="neu-btn inline-flex cursor-pointer items-center gap-1.5 text-sm">
              {step.actionLabel}
              <ArrowRight size={14} aria-hidden />
            </span>
          </Link>
        </div>
      </div>
    </li>
  );
}

export default function Onboarding() {
  const { user, userRole, rolePermissions, isDemoMode } = useAuth();
  const isClinicAdmin = userRole === "owner" || userRole === "manager" || userRole === "admin" || Boolean(rolePermissions.admin);

  const [profileState, setProfileState] = useState<StepState>("loading");
  const [teamState, setTeamState] = useState<StepState>("loading");
  const [leadState, setLeadState] = useState<StepState>("loading");
  const [adsState, setAdsState] = useState<StepState>("loading");
  const [clinicName, setClinicName] = useState("");

  useEffect(() => {
    if (!isClinicAdmin) return;
    let cancelled = false;
    async function load() {
      const workspaceId = readWorkspaceId();
      const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId)}`;
      // Real conditions only — the same endpoints the product already uses.
      const [settings, staff, leads, health] = await Promise.all([
        fetchJson(`/api/crm/admin-settings?${workspaceQuery}`),
        fetchJson(`/api/crm/staff?${workspaceQuery}`),
        fetchJson(`/api/crm/leads?${workspaceQuery}`),
        fetchJson("/api/crm/health"),
      ]);
      if (cancelled) return;

      if (settings.ok) {
        const clinicSetting = listFrom(settings.body, "settings", "items")
          .map(asRecord)
          .find((item) => str(item.key) === "clinic");
        const savedName = str(asRecord(clinicSetting?.value).clinicName);
        setClinicName(savedName);
        setProfileState(savedName ? "done" : "todo");
      } else {
        setProfileState("unknown");
      }

      setTeamState(staff.ok ? (listFrom(staff.body, "staff", "items").length > 0 ? "done" : "todo") : "unknown");
      setLeadState(leads.ok ? (listFrom(leads.body, "leads", "items").length > 0 ? "done" : "todo") : "unknown");

      if (health.ok) {
        const meta = asRecord(asRecord(asRecord(health.body).data).meta);
        setAdsState(meta.configured === true ? "done" : "todo");
      } else {
        setAdsState("unknown");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [isClinicAdmin]);

  // Ordinary employees get a short welcome instead of clinic-wide setup.
  if (!isClinicAdmin) {
    return (
      <PageLayout>
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-8 sm:px-6">
          <PageHeader
            kicker="Medina OS"
            title="Добро пожаловать"
            description="Ваш аккаунт подключён к клинике. Настройку клиники выполняет администратор — вы можете сразу перейти к работе."
          />
          <div className="flex flex-wrap gap-2">
            <Link href="/leads"><span className="neu-btn-primary inline-flex cursor-pointer items-center gap-2">Открыть заявки</span></Link>
            <Link href="/appointments"><span className="neu-btn inline-flex cursor-pointer items-center gap-2">Открыть записи</span></Link>
          </div>
        </div>
      </PageLayout>
    );
  }

  const steps: SetupStep[] = [
    {
      key: "profile",
      title: "Профиль клиники",
      explanation: "Название, контакты и часовой пояс клиники. Эти данные сохраняются на сервере и используются в работе CRM.",
      state: profileState,
      actionLabel: "Открыть настройки",
      actionHref: "/admin",
    },
    {
      key: "team",
      title: "Сотрудники",
      explanation: "Добавьте хотя бы одного сотрудника. Логин и временный пароль передаются сотруднику вручную администратором.",
      state: teamState,
      actionLabel: "Добавить сотрудника",
      actionHref: "/admin",
    },
    {
      key: "lead",
      title: "Первая заявка",
      explanation: "Создайте первую заявку, чтобы увидеть операционный процесс: источник, статус и ответственного.",
      state: leadState,
      actionLabel: "Открыть заявки",
      actionHref: "/leads",
    },
    {
      key: "ads",
      title: "Реклама",
      explanation: "Подключение Meta необязательно для начала работы. Кампании создаются выключенными и включаются вручную в Meta Ads Manager.",
      state: adsState,
      actionLabel: "Открыть рекламу",
      actionHref: "/ads-automation",
      optional: true,
    },
  ];

  const requiredSteps = steps.filter((step) => !step.optional);
  const doneRequired = requiredSteps.filter((step) => step.state === "done").length;
  const allRequiredDone = requiredSteps.length > 0 && doneRequired === requiredSteps.length;
  const anyLoading = steps.some((step) => step.state === "loading");

  return (
    <PageLayout>
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          kicker={isDemoMode ? "Medina OS · Демо-режим" : "Medina OS"}
          title="Настроим Medina OS для вашей клиники"
          description="Проверьте данные клиники, добавьте сотрудников и создайте первую рабочую запись."
        />

        <section aria-label="Прогресс настройки" className="neu p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold" style={{ color: "var(--ng-text)" }}>
              {clinicName || "Клиника"}
              {user?.email ? <span className="ml-2 text-xs font-medium" style={{ color: "var(--ng-muted)" }}>Администратор: {user.email}</span> : null}
            </p>
            <p aria-live="polite" className="text-sm font-medium tabular-nums" style={{ color: "var(--ng-muted)" }}>
              {anyLoading ? "Проверяем настройку…" : `Выполнено обязательных шагов: ${doneRequired} из ${requiredSteps.length}`}
            </p>
          </div>
          <div aria-hidden className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--ng-plate)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${requiredSteps.length ? (doneRequired / requiredSteps.length) * 100 : 0}%`, background: "var(--ng-primary)" }}
            />
          </div>
        </section>

        <ol className="space-y-3" aria-label="Шаги настройки клиники">
          {steps.map((step, index) => (
            <StepRow key={step.key} step={step} index={index + 1} />
          ))}
        </ol>

        {allRequiredDone ? (
          <section className="neu p-5" aria-live="polite">
            <div className="flex items-start gap-3">
              <CheckCircle2 size={22} aria-hidden style={{ color: "var(--ng-success)" }} />
              <div>
                <h2 className="text-lg font-semibold" style={{ color: "var(--ng-text)" }}>Клиника готова к работе</h2>
                <p className="mt-1 text-sm" style={{ color: "var(--ng-muted)" }}>
                  Обязательные шаги выполнены. Реклама остаётся необязательной и настраивается отдельно.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href="/ai-control-center"><span className="neu-btn-primary inline-flex cursor-pointer items-center gap-2">Перейти на главную</span></Link>
                  <Link href="/leads"><span className="neu-btn inline-flex cursor-pointer items-center gap-2"><Inbox size={15} aria-hidden />Открыть заявки</span></Link>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <p className="text-xs leading-relaxed" style={{ color: "var(--ng-muted)" }}>
          Статусы шагов определяются по реальным данным рабочего пространства. Открытие этой страницы не отмечает шаги выполненными.
        </p>
      </div>
    </PageLayout>
  );
}
