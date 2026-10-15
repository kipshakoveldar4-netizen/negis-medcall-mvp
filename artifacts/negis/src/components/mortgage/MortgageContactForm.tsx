import { useId, useState, type FormEvent } from "react";
import { Loader2, Save, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { phoneDigits } from "@/lib/phone";
import { mortgageButtonClass, mortgageContactStatus, mortgageErrorMessage, mortgageInputClass, mortgagePrimaryClass } from "./MortgagePrimitives";
import type { MortgageContact, MortgageMember } from "../../../../../lib/crm/mortgage-contract";

export type MortgageContactFields = {
  name: string; phone: string; notes: string; status?: string; responsibleUserId?: string;
};

export function MortgageContactForm({ contact, members, isCurrent, onSubmit, onClose }: {
  contact?: MortgageContact;
  members: MortgageMember[];
  isCurrent: () => boolean;
  onSubmit: (fields: MortgageContactFields) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(contact?.name || "");
  const [phone, setPhone] = useState(contact?.phone || "");
  const [notes, setNotes] = useState(contact?.notes || "");
  const [status, setStatus] = useState(contact ? contact.status : "new");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const statuses = ["new", "in_progress", "booked", "lost"];
  if (!statuses.includes(status)) statuses.push(status);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !isCurrent()) return;
    if (!name.trim()) {
      setError("Укажите имя клиента.");
      return;
    }
    const digits = phoneDigits(phone);
    if (digits.length < 7 || digits.length > 15) {
      setError("Укажите телефон: от 7 до 15 цифр.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        name: name.trim(), phone: phone.trim(), notes: notes.trim(),
        ...(contact ? { status } : responsibleUserId ? { responsibleUserId } : {}),
      });
      if (isCurrent()) onClose();
    } catch (cause) {
      if (isCurrent()) setError(mortgageErrorMessage(cause));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  if (!isCurrent()) return null;
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-lg border-[var(--negis-border)] bg-[var(--negis-surface)] text-[var(--negis-text)] [&>button:last-child]:hidden">
      <DialogClose asChild><button type="button" title="Закрыть" aria-label="Закрыть" disabled={saving} className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded hover:bg-[var(--negis-surface-2)] disabled:opacity-50"><X className="h-4 w-4" /></button></DialogClose>
      <DialogHeader><DialogTitle className="pr-6 text-left text-lg tracking-normal">{contact ? "Изменить контакт" : "Новый контакт"}</DialogTitle></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} aria-busy={saving}>
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="block text-xs font-medium">Имя</label>
            <input id={`${id}-name`} autoFocus autoComplete="name" required maxLength={200} className={mortgageInputClass} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-phone`} className="block text-xs font-medium">Телефон</label>
            <input id={`${id}-phone`} type="tel" autoComplete="tel" required maxLength={40} className={mortgageInputClass} value={phone} onChange={(event) => setPhone(event.target.value)} />
          </div>
          {contact ? <div className="space-y-1.5">
            <label htmlFor={`${id}-status`} className="block text-xs font-medium">Статус заявки</label>
            <select id={`${id}-status`} className={mortgageInputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              {statuses.map((value) => <option key={value} value={value}>{mortgageContactStatus(value)}</option>)}
            </select>
          </div> : <div className="space-y-1.5">
            <label htmlFor={`${id}-responsible`} className="block text-xs font-medium">Ответственный</label>
            <select id={`${id}-responsible`} className={mortgageInputClass} value={responsibleUserId} onChange={(event) => setResponsibleUserId(event.target.value)}>
              <option value="">Не назначен</option>
              {members.filter((member) => member.status === "active" && member.role === "lead_manager").map((member) => <option key={member.id} value={member.id}>{member.name || "Без имени"}</option>)}
            </select>
          </div>}
          <div className="space-y-1.5">
            <label htmlFor={`${id}-notes`} className="block text-xs font-medium">Заметки</label>
            <textarea id={`${id}-notes`} rows={5} maxLength={10000} className={`${mortgageInputClass} resize-y`} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </fieldset>
        {error && <p role="alert" className="break-words text-sm text-[var(--negis-error)]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={mortgageButtonClass} disabled={saving} onClick={onClose}>Отмена</button>
          <button type="submit" className={mortgagePrimaryClass} disabled={saving}>
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
