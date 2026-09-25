import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Plus, RefreshCw, Save, Globe, EyeOff } from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { CrmApiError, crmErrorMessage, crmFetch } from "@/lib/api";
import { emptyBlogDraft, type BlogDraft, type BlogDraftFields, type BlogSummary } from "../../../../lib/site/blog";

const errorText: Record<string, string> = {
  blog_not_configured: "Хранилище статей ещё не подключено. Нужна миграция 059.",
  blog_conflict: "Статья уже изменена или этот адрес занят. Ваш текст остался в редакторе. Проверьте другую вкладку и адрес статьи.",
  invalid_blog_draft: "Проверьте заголовок и адрес статьи: латинские буквы, цифры и дефисы.",
  workspace_access_denied: "Редактировать блог могут только владелец и администратор пространства.",
  authentication_required: "Войдите в аккаунт повторно.",
  publication_not_configured: "Публикация ещё не подключена. Нужна миграция 060.",
  incomplete_article: "Перед публикацией заполните краткое описание и текст статьи.",
};
function blogError(error: unknown, fallback: string): string {
  if (error instanceof CrmApiError) return errorText[error.code] || crmErrorMessage(error);
  return error instanceof Error ? error.message : fallback;
}
async function readReply(response: Response) {
  let data;
  try { data = JSON.parse(await response.text()); } catch { throw new Error("Не удалось подтвердить ответ сервера. Текст не удалён."); }
  if (!response.ok || data?.success !== true) throw new Error(Object.hasOwn(errorText, data?.code) ? errorText[data.code] : "Не удалось выполнить запрос. Попробуйте позже.");
  return data;
}

function BlogEditor({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<BlogSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listAvailable, setListAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<BlogDraft | null>(null);
  const [fields, setFields] = useState<BlogDraftFields | null>(null);
  const [baseline, setBaseline] = useState("");
  const [preview, setPreview] = useState(false);
  const [reload, setReload] = useState(0);
  const createId = useRef("");
  const dirty = fields !== null && JSON.stringify(fields) !== baseline;
  const endpoint = `/api/crm/site-blog?workspaceId=${encodeURIComponent(workspaceId)}`;

  useEffect(() => {
    let active = true;
    setLoading(true); setListAvailable(false); setRows([]); setError("");
    void crmFetch(`${endpoint}&offset=${offset}`, { cache: "no-store" }).then(readReply).then(data => {
      if (active) { setRows(data.data); setHasMore(data.hasMore === true); setListAvailable(true); }
    }).catch(err => { if (active) setError(blogError(err, "Не удалось загрузить статьи.")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [endpoint, offset, reload]);

  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);

  function replaceAllowed() { return !dirty || window.confirm("Есть несохранённый текст. Закрыть его без сохранения?"); }
  function newDraft() {
    if (!replaceAllowed()) return;
    const next = emptyBlogDraft();
    createId.current = crypto.randomUUID(); setSelected(null); setFields(next);
    setBaseline(JSON.stringify(next)); setPreview(false); setError(""); setNotice("");
  }
  function accept(draft: BlogDraft) {
    const next = { title: draft.title, slug: draft.slug, excerpt: draft.excerpt, body: draft.body, locale: draft.locale };
    setSelected(draft); setFields(next); setBaseline(JSON.stringify(next));
  }
  async function openDraft(id: string) {
    if (!replaceAllowed()) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await readReply(await crmFetch(`${endpoint}&id=${encodeURIComponent(id)}`, { cache: "no-store" })); accept(result.data); setPreview(false); }
    catch (err) { setError(blogError(err, "Не удалось открыть статью.")); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!fields || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await readReply(await crmFetch(endpoint, {
        method: selected ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, id: selected?.id || createId.current, ...(selected ? { version: selected.version } : {}) }),
      }));
      accept(result.data); setNotice("Черновик сохранён. Публичная версия не менялась.");
      setReload(value => value + 1);
    } catch (err) { setError(blogError(err, "Не удалось сохранить черновик.")); }
    finally { setBusy(false); }
  }
  async function changePublication(publish: boolean) {
    if (!selected || busy || dirty) return;
    if (!window.confirm(publish
      ? "Разрешить показ этой сохранённой версии на подключённом публичном сайте? Проверьте текст и права на его использование."
      : "Снять статью с публичного сайта? Черновик останется в кабинете.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await readReply(await crmFetch(endpoint, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, version: selected.version, action: publish ? "publish" : "unpublish" }),
      }));
      accept(result.data); setReload(value => value + 1);
      setNotice(publish ? "Версия разрешена для публикации на подключённом сайте." : "Публикация снята. Черновик сохранён.");
    } catch (err) { setError(blogError(err, "Не удалось изменить публикацию.")); }
    finally { setBusy(false); }
  }
  const inputClass = "w-full min-w-0 rounded border border-[var(--negis-border)] bg-[var(--negis-surface)] p-3 text-sm";
  const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded border border-[var(--negis-border)] px-3 py-2 text-sm disabled:opacity-50";

  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--negis-border)] pb-5">
      <div><h1 className="text-2xl font-semibold">Сайт и блог</h1><p className="mt-2 text-sm text-[var(--negis-muted)]">Статьи вашего пространства</p></div>
      <button className={buttonClass} disabled={busy || loading} onClick={newDraft}><Plus size={16} />Новая статья</button>
    </header>
    <p className="border-l-2 border-amber-500 pl-3 text-sm">Черновики закрыты. На подключённый сайт попадает только отдельно подтверждённая версия.</p>
    {error && <div role="alert" className="break-words border-l-2 border-red-500 p-3 text-sm">{error}</div>}
    {notice && <p role="status" className="text-sm text-[var(--negis-primary)]">{notice}</p>}
    <div className="grid min-w-0 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <section aria-label="Статьи" className="min-w-0 border-b border-[var(--negis-border)] pb-4 lg:border-b-0 lg:border-r lg:pr-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Черновики</h2><button className={buttonClass} title="Обновить список" aria-label="Обновить список" disabled={loading || busy} onClick={() => setReload(x => x + 1)}><RefreshCw size={16} /></button></div>
        {loading ? <p className="text-sm">Загружаем статьи…</p> : rows.length === 0 ? <p className="text-sm text-[var(--negis-muted)]">{listAvailable ? "Статей пока нет." : "Список недоступен."}</p> : <ul className="divide-y divide-[var(--negis-border)]">{rows.map(row => <li key={row.id}><button disabled={busy} onClick={() => void openDraft(row.id)} aria-current={selected?.id === row.id ? "true" : undefined} className="w-full min-w-0 py-3 text-left text-sm hover:underline"><span className="block break-words font-medium">{row.title}</span><span className="text-xs text-[var(--negis-muted)]">Черновик · {new Date(row.updatedAt).toLocaleDateString("ru-RU")}</span></button></li>)}</ul>}
        <div className="mt-4 flex gap-2"><button className={buttonClass} aria-label="Предыдущие статьи" title="Предыдущие статьи" disabled={offset === 0 || loading || busy} onClick={() => setOffset(x => Math.max(0, x - 20))}><ChevronLeft size={16} /></button><button className={buttonClass} aria-label="Следующие статьи" title="Следующие статьи" disabled={!hasMore || loading || busy} onClick={() => setOffset(x => x + 20)}><ChevronRight size={16} /></button></div>
      </section>
      <section className="min-w-0" aria-label="Редактор статьи">
        {!fields ? <div className="py-10 text-center text-[var(--negis-muted)]"><FileText size={32} className="mx-auto mb-3" /><p>Создайте статью или выберите черновик.</p></div> : <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Режим статьи" className="flex gap-1"><button role="tab" aria-selected={!preview} className={buttonClass} onClick={() => setPreview(false)}>Редактор</button><button role="tab" aria-selected={preview} className={buttonClass} onClick={() => setPreview(true)}>Предпросмотр</button></div>
            <span className="text-xs text-[var(--negis-muted)]">{dirty ? "Есть несохранённые изменения" : selected ? "Сохранено" : "Новый черновик"}</span>
          </div>
          {preview ? <article className="min-w-0 break-words border-y border-[var(--negis-border)] py-6"><p className="mb-3 text-xs text-[var(--negis-muted)]">Закрытый предпросмотр · русский</p><h2 className="text-2xl font-semibold">{fields.title || "Без заголовка"}</h2><p className="my-4 whitespace-pre-wrap text-[var(--negis-muted)]">{fields.excerpt}</p>{fields.body.split(/\n\s*\n/).map((paragraph, index) => <p key={index} className="mb-4 whitespace-pre-wrap leading-relaxed">{paragraph}</p>)}</article>
            : <fieldset disabled={busy} className="min-w-0 space-y-4"><label className="block text-sm">Заголовок<input className={inputClass} maxLength={200} value={fields.title} onChange={e => setFields({ ...fields, title: e.target.value })} /></label><label className="block text-sm">Адрес статьи<input className={inputClass} placeholder="kak-podgotovit-reklamu" maxLength={100} value={fields.slug} onChange={e => setFields({ ...fields, slug: e.target.value })} /></label><label className="block text-sm">Краткое описание<textarea className={inputClass} rows={3} maxLength={500} value={fields.excerpt} onChange={e => setFields({ ...fields, excerpt: e.target.value })} /></label><label className="block text-sm">Текст статьи<textarea className={`${inputClass} min-h-72`} rows={14} maxLength={30000} value={fields.body} onChange={e => setFields({ ...fields, body: e.target.value })} /></label></fieldset>}
          {selected && <p className="mt-4 text-sm" role="status">{selected.publishedAt
            ? selected.publishedVersion === selected.version ? "Сохранённая версия разрешена для сайта." : "Есть изменения, не включённые в публичную версию."
            : "Статья не опубликована."}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button className={`${buttonClass} bg-[var(--negis-primary)] text-white`} disabled={busy || !fields.title.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.slug)} onClick={() => void save()}><Save size={16} />{busy ? "Сохраняем…" : "Сохранить черновик"}</button>
            <button className={buttonClass} disabled={busy || dirty || !selected || !fields.body.trim() || !fields.excerpt.trim()} onClick={() => void changePublication(true)}><Globe size={16} />{selected?.publishedAt ? "Обновить публикацию" : "Разрешить публикацию"}</button>
            {selected?.publishedAt && <button className={buttonClass} disabled={busy || dirty} onClick={() => void changePublication(false)}><EyeOff size={16} />Снять с публикации</button>}
          </div>
        </>}
      </section>
    </div>
  </div>;
}

export default function SiteBlog() {
  const { clinicId, isDemoMode, isImpersonation } = useAuth();
  return <PageLayout>{clinicId && !isDemoMode && !isImpersonation
    ? <BlogEditor key={clinicId} workspaceId={clinicId} />
    : <p>Для работы с блогом войдите в своё рабочее пространство.</p>}</PageLayout>;
}
