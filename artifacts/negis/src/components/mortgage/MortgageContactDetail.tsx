import { useState } from "react";
import { CalendarPlus, ClipboardPlus, Pencil, Phone, RefreshCw, X } from "lucide-react";
import { Link } from "wouter";
import { useMortgageWorkspace } from "@/lib/mortgage-workspace";
import { useAuth } from "@/contexts/AuthContext";
import { MortgageContractPanel } from "@/components/mortgage/MortgageContractPanel";
import { formatPhone, toTelHref } from "@/lib/phone";
import type { MortgageContact } from "../../../../../lib/crm/mortgage-contract";
import { MortgageContactForm } from "./MortgageContactForm";
import {
  MortgageActivityTable, MortgageContactBadge, MortgageIconButton, MortgageState, mortgageButtonClass,
  mortgageDate, mortgageErrorMessage,
} from "./MortgagePrimitives";

const eventLabels: Record<string, string> = {
  created: "Создание", updated: "Изменение", status_changed: "Изменение статуса",
  open: "Запланировано", in_progress: "В работе", done: "Завершение", cancelled: "Отмена", missed: "Неявка",
};

export function MortgageContactDetail({ leadId, canEdit, onClose, onChanged }: {
  leadId: string; canEdit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { clinicId, userRole } = useAuth();
  const workspace = useMortgageWorkspace({ leadId });
  const [editingContact, setEditingContact] = useState<MortgageContact | null>(null);
  const data = workspace.isCurrent() && !workspace.loading && !workspace.error ? workspace.data : null;
  const contact = data?.contacts.find((item) => item.id === leadId);
  const activities = data?.activities.filter((activity) => activity.leadId === leadId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) || [];
  const events = data ? [...data.events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : [];

  return <section className="min-w-0 scroll-mt-4 border-b border-[var(--negis-border)] pb-5 xl:border-b-0 xl:border-l xl:pb-0 xl:pl-5" aria-label="Карточка клиента">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--negis-border)] pb-3">
      <h2 className="text-sm font-semibold">Карточка клиента</h2>
      <div className="flex gap-2">
        {contact && canEdit && <MortgageIconButton icon={Pencil} label="Изменить контакт" onClick={() => setEditingContact(contact)} />}
        <MortgageIconButton icon={RefreshCw} label="Обновить карточку клиента" disabled={workspace.loading} onClick={() => void workspace.refresh()} />
        <MortgageIconButton icon={X} label="Закрыть карточку клиента" onClick={onClose} />
      </div>
    </div>
    {workspace.loading ? <MortgageState kind="loading">Загрузка карточки...</MortgageState>
      : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
      : !data ? <MortgageState kind="empty">Карточка недоступна.</MortgageState>
      : !contact ? <MortgageState kind="empty">Контакт не найден или недоступен.</MortgageState>
      : <div className="min-w-0 space-y-5">
        <div className="min-w-0">
          <h3 className="break-words text-lg font-semibold">{contact.name || "Без имени"}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {contact.phone ? <a href={toTelHref(contact.phone)} className="inline-flex min-w-0 items-center gap-2 text-[var(--negis-primary)] hover:underline">
              <Phone size={14} className="shrink-0" aria-hidden="true" /><span className="break-all">{formatPhone(contact.phone)}</span>
            </a> : <span className="text-[var(--negis-muted)]">Телефон не указан</span>}
            <MortgageContactBadge status={contact.status} />
          </div>
        </div>

        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-3 border-y border-[var(--negis-border)] py-4 text-xs">
          <dt className="text-[var(--negis-muted)]">Источник</dt><dd className="break-words">{contact.source === "manual" ? "Вручную" : contact.source || "Не указан"}</dd>
          <dt className="text-[var(--negis-muted)]">Ответственный</dt><dd className="break-words">{contact.responsibleName || (contact.responsibleUserId ? "Имя не указано" : "Не назначен")}</dd>
          <dt className="text-[var(--negis-muted)]">Создана</dt><dd className="break-words">{mortgageDate(contact.createdAt, data.timeZone)}</dd>
          <dt className="text-[var(--negis-muted)]">Обновлена</dt><dd className="break-words">{mortgageDate(contact.updatedAt, data.timeZone)}</dd>
          <dt className="text-[var(--negis-muted)]">Часовой пояс</dt><dd className="break-words">{data.timeZone}</dd>
        </dl>

        <div>
          <h3 className="mb-2 text-xs font-semibold">Заметки</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-[var(--negis-text-2)]">{contact.notes || "Нет заметок."}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href={`/appointments?leadId=${encodeURIComponent(contact.id)}&new=1`} className={mortgageButtonClass}>
            <CalendarPlus size={15} aria-hidden="true" />Новая встреча
          </Link>
          <Link href={`/tasks?leadId=${encodeURIComponent(contact.id)}&new=1`} className={mortgageButtonClass}>
            <ClipboardPlus size={15} aria-hidden="true" />Новая задача
          </Link>
        </div>

        {clinicId && <MortgageContractPanel leadId={leadId} workspaceId={clinicId} timeZone={data.timeZone}
          canEdit={canEdit} canVoid={userRole === "owner" || userRole === "admin"}
          request={workspace.request} isCurrent={workspace.isCurrent} />}

        <section className="min-w-0 border-t border-[var(--negis-border)] pt-4" aria-labelledby="mortgage-contact-activities">
          <h3 id="mortgage-contact-activities" className="mb-2 text-sm font-semibold">Встречи и задачи</h3>
          {data.activitiesTruncated && <p role="status" className="mb-2 text-xs text-[var(--negis-warning)]">Неполная выборка встреч и задач.</p>}
          {activities.length ? <div className="max-h-80 overflow-y-auto"><MortgageActivityTable activities={activities} timeZone={data.timeZone} showContact={false} /></div>
            : <MortgageState kind="empty">{data.activitiesTruncated ? "В выборке нет встреч и задач." : "Встреч и задач нет."}</MortgageState>}
        </section>

        <section className="min-w-0 border-t border-[var(--negis-border)] pt-4" aria-labelledby="mortgage-contact-history">
          <h3 id="mortgage-contact-history" className="mb-2 text-sm font-semibold">История действий</h3>
          {events.length ? <ol className="max-h-96 space-y-0 overflow-y-auto">
            {events.map((event) => <li key={event.id} className="min-w-0 border-b border-[var(--negis-border)] py-3 last:border-b-0">
              <p className="break-words text-sm font-medium">{event.title || "Событие"}</p>
              <p className="mt-1 break-words text-xs text-[var(--negis-muted)]">{Object.hasOwn(eventLabels, event.action) ? eventLabels[event.action] : event.action} · {event.actorName || "Автор не указан"}</p>
              <time dateTime={event.createdAt} className="mt-1 block text-xs tabular-nums text-[var(--negis-muted)]">{mortgageDate(event.createdAt, data.timeZone)}</time>
            </li>)}
          </ol> : <MortgageState kind="empty">Действий пока нет.</MortgageState>}
        </section>

      </div>}
    {editingContact && canEdit && <MortgageContactForm contact={editingContact} request={workspace.request} isCurrent={workspace.isCurrent}
      onClose={() => setEditingContact(null)} onSubmit={async ({ name, phone, notes, status }) => {
        await workspace.updateContact(editingContact.id, { name, phone, notes, status });
        if (workspace.isCurrent()) onChanged();
      }} />}
  </section>;
}
