import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CalendarDays, Check, Loader2, Save, Search, UserRound, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import {
  mortgageDateTimeToIso, mortgageLocalDateTime,
  mortgagePriorityLabels, mortgageStatusLabels, useMortgageWorkspace,
  type MortgageActivity, type MortgageActivityDraft, type MortgageActivityKind, type MortgageActivityStatus,
  type MortgageContact, type MortgagePriority,
} from "@/lib/mortgage-workspace";
import { mortgageButtonClass, mortgageInputClass as mortgageFieldClass, mortgagePrimaryClass } from "./MortgagePrimitives";

type Workspace = ReturnType<typeof useMortgageWorkspace>;
export type ActivityDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  kind: MortgageActivityKind;
  activity?: MortgageActivity;
  leadId?: string;
  initialStartsAt?: string;
};

export function ActivityDialog(props: ActivityDialogProps) {
  if (!props.open || !props.workspace.data || !props.workspace.isCurrent()) return null;
  return <Dialog open onOpenChange={props.onOpenChange}>
    <ActivityForm key={`${props.activity?.id || "new"}:${props.kind}`} {...props} timeZone={props.workspace.data.timeZone} />
  </Dialog>;
}

// An activity can belong to a client outside the current contacts page.
function LinkedContact({ leadId, onLoaded }: { leadId: string; onLoaded: (contact: MortgageContact | null, error: string) => void }) {
  const workspace = useMortgageWorkspace({ leadId, days: 7 });
  useEffect(() => {
    if (workspace.loading || !workspace.isCurrent()) return;
    const contact = workspace.data?.contacts.find((item) => item.id === leadId) ?? null;
    onLoaded(contact, workspace.error || (!contact ? "Клиент недоступен. Выберите клиента заново." : ""));
  }, [leadId, onLoaded, workspace.data, workspace.error, workspace.loading, workspace.isCurrent]);
  return null;
}

function nextHour(local: string): string {
  return new Date(Date.parse(`${local}:00Z`) + 3_600_000).toISOString().slice(0, 16);
}

function ActivityForm({ workspace, activity, kind, leadId, initialStartsAt, onOpenChange, timeZone }: ActivityDialogProps & { timeZone: string }) {
  const { clinicId, userRole } = useAuth();
  const id = useId();
  const initialLead = activity?.leadId || leadId || "";
  const initialStart = mortgageLocalDateTime(activity?.startsAt, timeZone) || initialStartsAt || mortgageLocalDateTime(new Date().toISOString(), timeZone);
  const [title, setTitle] = useState(activity?.title || "");
  const [notes, setNotes] = useState(activity?.notes || "");
  const [status, setStatus] = useState<MortgageActivityStatus>(activity?.status || "open");
  const [priority, setPriority] = useState<MortgagePriority>(activity?.priority || "normal");
  const [startsAt, setStartsAt] = useState(initialStart);
  const [endsAt, setEndsAt] = useState(mortgageLocalDateTime(activity?.endsAt, timeZone) || nextHour(initialStart));
  const [dueAt, setDueAt] = useState(mortgageLocalDateTime(activity?.dueAt, timeZone));
  const [selectedId, setSelectedId] = useState(initialLead);
  const [selected, setSelected] = useState<MortgageContact | null>(null);
  const [contactError, setContactError] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MortgageContact[]>(workspace.data?.contacts ?? []);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const savingRef = useRef(false);
  const alive = useRef(true);
  const [selfAdmin, setSelfAdmin] = useState<{ workspaceId: string; staffUserId: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setSelfAdmin(null);
    if (kind !== "meeting" || userRole !== "admin" || !clinicId || !workspace.isCurrent()) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await workspace.request(`/api/crm/auth-context?${new URLSearchParams({ workspaceId: clinicId })}`, { signal: controller.signal });
        const body = await response.json();
        if (!active || !workspace.isCurrent()) return;
        const data = body?.data;
        if (response.ok && body?.success === true && body?.mode === "supabase" && data?.workspaceId === clinicId
          && data?.purpose === "mortgage_leads" && data?.role === "admin" && typeof data?.staffUserId === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.staffUserId)) {
          setSelfAdmin({ workspaceId: clinicId, staffUserId: data.staffUserId });
        }
      } catch { /* Only a verified response can enable the admin-self exception. */ }
    })();
    return () => { active = false; controller.abort(); };
  }, [clinicId, userRole, kind, workspace.request, workspace.isCurrent]);
  const loaded = useCallback((contact: MortgageContact | null, loadError: string) => {
    setSelected(contact);
    setContactError(loadError);
  }, []);
  useEffect(() => {
    let active = true;
    setSearchError("");
    setSearching(true);
    setResults([]);
    const timeout = window.setTimeout(() => {
      void workspace.searchContacts(search.trim()).then((contacts) => {
        if (active && workspace.isCurrent()) setResults(contacts);
      }).catch((reason: unknown) => {
        if (active && workspace.isCurrent()) setSearchError(reason instanceof Error ? reason.message : "Не удалось найти клиента.");
      }).finally(() => { if (active && workspace.isCurrent()) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [search, workspace.searchContacts, workspace.isCurrent]);
  const manager = workspace.data?.members.find((member) => member.id === selected?.responsibleUserId && member.status === "active"
    && (member.role === "lead_manager" || (member.role === "admin" && userRole === "admin"
      && selfAdmin !== null && selfAdmin.workspaceId === clinicId && member.id === selfAdmin.staffUserId)));
  const allowedStatuses: MortgageActivityStatus[] = kind === "meeting" ? ["open", "done", "cancelled", "missed"] : ["open", "in_progress", "done", "cancelled"];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!alive.current || savingRef.current || !workspace.isCurrent()) return;
    setError("");
    if (!selected || selected.id !== selectedId) { setError("Выберите доступного клиента."); return; }
    if (kind === "meeting" && !manager) { setError("Для встречи клиенту нужен активный менеджер или вы как ответственный администратор."); return; }
    if (!title.trim()) { setError("Укажите название."); return; }
    if (!allowedStatuses.includes(status)) { setError("Выберите допустимый статус."); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      const startIso = kind === "meeting" ? mortgageDateTimeToIso(startsAt, timeZone, activity?.startsAt) : null;
      const endIso = kind === "meeting" ? mortgageDateTimeToIso(endsAt, timeZone, activity?.endsAt) : null;
      if (startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) throw new Error("Окончание встречи должно быть позже начала.");
      const draft: MortgageActivityDraft & { requestId: string } = {
        requestId, kind, leadId: selected.id, title: title.trim(), notes: notes.trim(), status, priority,
        startsAt: startIso, endsAt: endIso,
        dueAt: kind === "task" && dueAt ? mortgageDateTimeToIso(dueAt, timeZone, activity?.dueAt) : null,
      };
      await workspace.saveActivity(draft, activity);
      if (alive.current && workspace.isCurrent()) onOpenChange(false);
    } catch (reason) {
      if (alive.current && workspace.isCurrent()) setError(reason instanceof Error ? reason.message : "Не удалось сохранить запись.");
    } finally {
      savingRef.current = false;
      if (alive.current && workspace.isCurrent()) setSaving(false);
    }
  };
  return <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-xl overflow-y-auto rounded-lg bg-[var(--negis-surface)] text-[var(--negis-text)] [&>button:last-child]:hidden" style={{ letterSpacing: 0 }}
    onEscapeKeyDown={(event) => { if (savingRef.current) event.preventDefault(); }}
    onInteractOutside={(event) => { if (savingRef.current) event.preventDefault(); }}>
    <DialogClose asChild><button type="button" className="mortgage-control absolute right-3 top-3 flex h-10 w-10 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-lg hover:bg-[var(--negis-surface-2)] disabled:opacity-50" title="Закрыть" aria-label="Закрыть" disabled={saving}><X className="h-4 w-4" /></button></DialogClose>
    <DialogHeader>
      <DialogTitle className="pr-7 text-xl leading-snug" style={{ letterSpacing: 0 }}>{activity ? "Редактирование" : kind === "meeting" ? "Новая встреча" : "Новая задача"}</DialogTitle>
      <DialogDescription className="flex items-center gap-2 break-all text-sm"><CalendarDays className="h-4 w-4 shrink-0" />{timeZone}</DialogDescription>
    </DialogHeader>
    <form onSubmit={(event) => void submit(event)} className="grid min-w-0 gap-4">
      <fieldset disabled={saving} className="grid min-w-0 gap-4 disabled:opacity-70">
        <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-title`}>Название
          <input id={`${id}-title`} className={mortgageFieldClass} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required autoFocus />
        </label>
        <div className="grid min-w-0 gap-2">
          <label className="text-sm" htmlFor={`${id}-client`}>Клиент</label>
          {selectedId ? <>
            <LinkedContact key={selectedId} leadId={selectedId} onLoaded={loaded} />
            <div className="flex min-w-0 items-center gap-2 border-b border-[var(--negis-border)] py-2">
              <UserRound className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1 text-sm"><p className="break-words font-medium">{selected?.name || (contactError ? "Клиент недоступен" : "Загрузка клиента...")}</p><p className="break-words text-xs text-[var(--negis-muted)]">{selected?.phone}</p></div>
              <button type="button" className={mortgageButtonClass} title="Сменить клиента" aria-label="Сменить клиента" onClick={() => { setSelectedId(""); setSelected(null); setContactError(""); }}><X className="h-4 w-4" /></button>
            </div>
            {contactError && <p role="alert" className="text-sm text-red-700">{contactError}</p>}
          </> : <>
            <div className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[var(--negis-muted)]" /><input id={`${id}-client`} className={`${mortgageFieldClass} pl-9`} value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Имя или телефон" autoComplete="off" /></div>
            <div className="max-h-40 overflow-y-auto" aria-live="polite">
              {searching ? <p className="py-2 text-sm text-[var(--negis-muted)]">Поиск...</p> : searchError ? <p role="alert" className="text-sm text-red-700">{searchError}</p> : results.length === 0 ? <p className="py-2 text-sm text-[var(--negis-muted)]">Клиенты не найдены</p> : results.map((contact) => <button key={contact.id} type="button" className="flex w-full min-w-0 items-center gap-2 border-b border-[var(--negis-border)] px-2 py-3 text-left text-sm hover:bg-[var(--negis-surface-2)]" onClick={() => { setSelected(null); setSelectedId(contact.id); setContactError(""); }}><span className="min-w-0 flex-1 break-words">{contact.name}<span className="block text-xs text-[var(--negis-muted)]">{contact.phone}</span></span><Check className="h-4 w-4 shrink-0" /></button>)}
            </div>
          </>}
          {selected && <p className={`break-words text-sm ${kind === "meeting" && !manager ? "text-amber-800" : "text-[var(--negis-muted)]"}`}>Ответственный: {selected.responsibleName || "не назначен"}{kind === "meeting" && !manager ? ". Нет доступного ответственного." : ""}</p>}
        </div>
        {kind === "meeting" ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-start`}>Начало<input id={`${id}-start`} className={mortgageFieldClass} type="datetime-local" value={startsAt} onInput={(event) => setStartsAt(event.currentTarget.value)} onChange={(event) => setStartsAt(event.target.value)} required /></label>
          <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-end`}>Окончание<input id={`${id}-end`} className={mortgageFieldClass} type="datetime-local" value={endsAt} onInput={(event) => setEndsAt(event.currentTarget.value)} onChange={(event) => setEndsAt(event.target.value)} required /></label>
        </div> : <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-due`}>Срок<input id={`${id}-due`} className={mortgageFieldClass} type="datetime-local" value={dueAt} onInput={(event) => setDueAt(event.currentTarget.value)} onChange={(event) => setDueAt(event.target.value)} /></label>}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-status`}>Статус<select id={`${id}-status`} className={mortgageFieldClass} value={status} onChange={(event) => setStatus(event.target.value as MortgageActivityStatus)}>{allowedStatuses.map((value) => <option key={value} value={value}>{kind === "task" && value === "open" ? "Открыта" : mortgageStatusLabels[value]}</option>)}</select></label>
          <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-priority`}>Приоритет<select id={`${id}-priority`} className={mortgageFieldClass} value={priority} onChange={(event) => setPriority(event.target.value as MortgagePriority)}>{(["low", "normal", "high"] as const).map((value) => <option key={value} value={value}>{mortgagePriorityLabels[value]}</option>)}</select></label>
        </div>
        <label className="grid min-w-0 gap-1.5 text-sm" htmlFor={`${id}-notes`}>Заметки<textarea id={`${id}-notes`} className={`${mortgageFieldClass} h-auto py-2`} rows={3} maxLength={10_000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      </fieldset>
      {error && <p role="alert" className="break-words border-l-2 border-red-600 pl-3 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--negis-border)] pt-4">
        <button type="button" className={mortgageButtonClass} disabled={saving} onClick={() => onOpenChange(false)}>Отмена</button>
        <button type="submit" className={mortgagePrimaryClass} disabled={saving || !selected || (kind === "meeting" && !manager)}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saving ? "Сохранение..." : "Сохранить"}</button>
      </div>
    </form>
  </DialogContent>;
}

export default ActivityDialog;
