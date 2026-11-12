import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, RefreshCw, Search, X } from "lucide-react";
import { useSearchParams } from "wouter";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { MortgageScope, useMortgageWorkspace } from "@/lib/mortgage-workspace";
import { formatPhone, toTelHref } from "@/lib/phone";
import { MortgageContactDetail } from "@/components/mortgage/MortgageContactDetail";
import { MortgageContactForm } from "@/components/mortgage/MortgageContactForm";
import {
  MortgageContactBadge, MortgageIconButton, MortgagePageHeader, MortgageState, mortgageDate,
  mortgageErrorMessage, mortgageInputClass, mortgagePrimaryClass, mortgageTableClass,
} from "@/components/mortgage/MortgagePrimitives";

export default function MortgageClients() {
  return <PageLayout><MortgageScope><MortgageClientsBody /></MortgageScope></PageLayout>;
}

function MortgageClientsBody() {
  const { clinicId, userRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const leadId = params.get("leadId") || "";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ q: "", page: 0 });
  const [creating, setCreating] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  const workspace = useMortgageWorkspace(query);
  const canCreate = userRole === "owner" || userRole === "admin";
  const canEdit = canCreate || userRole === "manager" || userRole === "lead_manager";
  const searchPending = search.trim() !== query.q;
  const busy = workspace.loading || searchPending;
  const data = workspace.isCurrent() && !busy && !workspace.error ? workspace.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.contactsTotal / data.pageSize)) : 1;
  const first = data && data.contacts.length ? data.page * data.pageSize + 1 : 0;
  const last = data && data.contacts.length ? data.page * data.pageSize + data.contacts.length : 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      setQuery((previous) => previous.q === q ? previous : { q, page: 0 });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (data && data.page >= pages) setQuery((previous) => ({ ...previous, page: pages - 1 }));
  }, [data, pages]);

  useEffect(() => {
    if (leadId && window.matchMedia("(max-width: 1279px)").matches) detailRef.current?.scrollIntoView({ block: "start" });
  }, [leadId]);

  function selectContact(id: string) {
    if (!workspace.isCurrent()) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id) next.set("leadId", id);
      else next.delete("leadId");
      return next;
    });
  }

  function goToPage(page: number) {
    if (!data || busy || page < 0 || page >= pages || !workspace.isCurrent()) return;
    setQuery((previous) => ({ ...previous, page }));
  }

  return <div className="min-w-0 space-y-5">
    <MortgagePageHeader title="Клиенты" caption={userRole === "manager" || userRole === "lead_manager" ? "Мои контакты" : "Контакты Baspana"}>
      <MortgageIconButton icon={RefreshCw} label="Обновить клиентов" disabled={busy} onClick={() => void workspace.refresh()} />
      {canCreate && <button type="button" className={mortgagePrimaryClass} disabled={!data} onClick={() => setCreating(true)}>
        <Plus size={16} aria-hidden="true" />Новый контакт
      </button>}
    </MortgagePageHeader>

    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--negis-border)] pb-4">
      <div className="relative w-full min-w-0 sm:max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--negis-muted)]" aria-hidden="true" />
        <input type="search" aria-label="Поиск клиентов по имени или телефону" placeholder="Имя или телефон"
          className={`${mortgageInputClass} pl-9 pr-11`} value={search} maxLength={100}
          onChange={(event) => setSearch(event.target.value)} />
        {search && <button type="button" aria-label="Очистить поиск" title="Очистить поиск" className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--negis-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)]" onClick={() => setSearch("")}>
          <X size={15} aria-hidden="true" />
        </button>}
      </div>
      {data && <p className="text-xs tabular-nums text-[var(--negis-muted)]">{query.q ? "Найдено" : "Всего"}: {data.contactsTotal.toLocaleString("ru-RU")}</p>}
    </div>

    <div className={`grid min-w-0 items-start gap-5 ${leadId ? "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "grid-cols-1"}`}>
      <section className="order-2 min-w-0 xl:order-1" aria-label="Список клиентов" aria-busy={busy}>
        {!clinicId ? <MortgageState kind="denied">Рабочее пространство не выбрано.</MortgageState>
          : busy ? <MortgageState kind="loading">Загрузка клиентов...</MortgageState>
          : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
          : !data ? <MortgageState kind="empty">Список клиентов недоступен.</MortgageState>
          : <>
            {data.contacts.length ? <div className={`${mortgageTableClass} max-h-[65dvh] overflow-y-auto`} role="region" aria-label="Контакты клиентов" tabIndex={0}>
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[var(--negis-surface)] text-[var(--negis-muted)]">
                  <tr>{["Клиент", "Телефон", "Статус заявки", "Источник", "Ответственный", "Обновлена"].map((label) => <th key={label} scope="col" className="px-2 py-2.5 font-medium">{label}</th>)}</tr>
                </thead>
                <tbody>{data.contacts.map((contact) => <tr key={contact.id} className="border-t border-[var(--negis-border)] align-top hover:bg-[var(--negis-surface-2)]"
                  style={contact.id === leadId ? { background: "var(--negis-primary-soft)" } : undefined}>
                  <th scope="row" className="min-w-40 max-w-60 px-3 py-3 font-medium">
                    <button type="button" className="w-full break-words text-left text-[var(--negis-text)] hover:text-[var(--negis-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)]"
                      aria-pressed={contact.id === leadId} onClick={() => selectContact(contact.id)}>{contact.name || "Без имени"}</button>
                  </th>
                  <td className="whitespace-nowrap px-2 py-3">{contact.phone ? <a href={toTelHref(contact.phone)} className="hover:underline">{formatPhone(contact.phone)}</a> : "Не указан"}</td>
                  <td className="min-w-28 px-2 py-3"><MortgageContactBadge status={contact.status} /></td>
                  <td className="max-w-40 break-words px-2 py-3">{contact.source === "manual" ? "Вручную" : contact.source || "Не указан"}</td>
                  <td className="max-w-44 break-words px-2 py-3">{contact.responsibleName || (contact.responsibleUserId ? "Имя не указано" : "Не назначен")}</td>
                  <td className="min-w-32 px-2 py-3 tabular-nums">{mortgageDate(contact.updatedAt, data.timeZone)}</td>
                </tr>)}</tbody>
              </table>
            </div> : <MortgageState kind="empty">{query.q ? "Клиенты не найдены." : "Контактов пока нет."}</MortgageState>}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--negis-border)] pt-3">
              <p className="text-xs tabular-nums text-[var(--negis-muted)]">{first.toLocaleString("ru-RU")}-{last.toLocaleString("ru-RU")} из {data.contactsTotal.toLocaleString("ru-RU")}</p>
              <nav aria-label="Страницы клиентов" className="flex flex-wrap items-center gap-1.5">
                <MortgageIconButton icon={ChevronsLeft} label="Первая страница" disabled={busy || data.page === 0} onClick={() => goToPage(0)} />
                <MortgageIconButton icon={ChevronLeft} label="Предыдущая страница" disabled={busy || data.page === 0} onClick={() => goToPage(data.page - 1)} />
                <span className="min-w-16 px-1 text-center text-xs tabular-nums" aria-current="page">{data.page + 1} / {pages}</span>
                <MortgageIconButton icon={ChevronRight} label="Следующая страница" disabled={busy || data.page >= pages - 1} onClick={() => goToPage(data.page + 1)} />
                <MortgageIconButton icon={ChevronsRight} label="Последняя страница" disabled={busy || data.page >= pages - 1} onClick={() => goToPage(pages - 1)} />
              </nav>
            </div>
          </>}
      </section>

      {leadId && clinicId && <div ref={detailRef} className="order-1 min-w-0 scroll-mt-4 xl:order-2">
        <MortgageContactDetail key={leadId} leadId={leadId} canEdit={canEdit} onClose={() => selectContact("")} onChanged={() => void workspace.refresh()} />
      </div>}
    </div>

    {creating && canCreate && <MortgageContactForm request={workspace.request} isCurrent={workspace.isCurrent}
      onClose={() => setCreating(false)} onSubmit={async ({ name, phone, notes, responsibleUserId }) => {
        await workspace.createContact({ name, phone, notes, ...(responsibleUserId ? { responsibleUserId } : {}) });
      }} />}
  </div>;
}
