import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import type { TikTokVideoList, TikTokVideoSummary } from "../../../../../lib/tiktok/videoAssets";

type Props = {
  enabled: boolean;
  list: (signal: AbortSignal) => Promise<TikTokVideoList>;
  request: (assetId: string, transfer: boolean, retry: boolean, signal: AbortSignal) => Promise<TikTokVideoSummary>;
  onSelected: (assetId: string) => void;
};
export function TikTokVideoUpload({ enabled, list, request, onSelected }: Props) {
  const [library, setLibrary] = useState<TikTokVideoList | null>(null);
  const [selected, setSelected] = useState("");
  const [summary, setSummary] = useState<TikTokVideoSummary | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ list, request, onSelected });
  callbacks.current = { list, request, onSelected };
  function begin() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setMessage(""); setConfirmed(false);
    return current;
  }
  async function refreshLibrary() {
    if (!enabled) return;
    const current = begin();
    setLibrary(null); setSelected(""); setSummary(null); callbacks.current.onSelected("");
    try {
      const data = await callbacks.current.list(current.signal);
      if (!current.signal.aborted) setLibrary(data);
    } catch (error) {
      if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "Не удалось прочитать видео клиники.");
    } finally { if (!current.signal.aborted) setBusy(false); }
  }
  async function load(assetId: string, transfer = false) {
    if (!enabled || !assetId) return;
    const retry = summary?.canRetry === true;
    const current = begin();
    setSummary(null);
    try {
      const data = await callbacks.current.request(assetId, transfer, retry, current.signal);
      if (current.signal.aborted) return;
      setSummary(data); callbacks.current.onSelected(assetId);
    } catch (error) {
      if (!current.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "Не удалось проверить передачу видео. Обновите статус.");
        callbacks.current.onSelected("");
      }
    } finally { if (!current.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (enabled) void refreshLibrary();
    return () => controller.current?.abort();
  }, [enabled]);
  const asset = library?.assets.find((item) => item.id === selected);
  const canTransfer = library?.enabled && !asset?.issue && (summary?.status === "not_uploaded" || summary?.canRetry);
  return (
    <div className="my-5 min-w-0 border-y border-[#E2E8F0] py-4" data-testid="tiktok-video-upload">
      <h3 className="text-sm font-bold text-[#0F172A]">Видео для TikTok</h3>
      {!enabled ? <p className="mt-2 text-sm text-[#64748B]">Для передачи видео нужен подтверждённый админ-доступ.</p> : (
        <>
          {library ? <>
            <label className="mt-3 block min-w-0 text-sm text-[#64748B]">Ролик клиники
              <select className="neu-input mt-1 w-full min-w-0 max-w-full" value={selected} disabled={busy}
                onChange={(event) => {
                  const id = event.target.value; setSelected(id); setSummary(null); setConfirmed(false);
                  callbacks.current.onSelected(""); if (id) void load(id);
                }}>
                <option value="">Выберите видео</option>
                {library.assets.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}
              </select>
            </label>
            {asset ? <p className="mt-1 break-words text-xs text-[#64748B]">{asset.fileName}</p> : null}
            {!library.assets.length ? <p className="mt-2 text-sm text-[#64748B]">В библиотеке клиники пока нет видео.</p> : null}
            {!library.enabled ? <p className="mt-2 text-sm text-amber-800">Передача видео пока отключена оператором.</p> : null}
            {asset?.issue ? <p className="mt-2 break-words text-sm text-amber-800">{asset.issue}</p> : null}
          </> : null}
          <div className="mt-3 min-w-0 break-words text-sm" aria-live="polite">
            {busy ? <p className="text-[#64748B]">Проверяем видео и статус передачи…</p> : null}
            {message ? <p role="alert" className="text-amber-800">{message}</p> : null}
            {summary ? <p className={summary.status === "uploaded" ? "text-emerald-800" : "text-[#64748B]"}>{summary.message}</p> : null}
          </div>
          {canTransfer ? <label className="mt-3 flex items-start gap-2 text-sm text-[#475569]">
            <input type="checkbox" className="mt-1 shrink-0" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>Подтверждаю передачу выбранного ролика в рекламную библиотеку TikTok.</span>
          </label> : null}
          <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
            <button type="button" className="neu-btn flex min-h-11 w-full items-center justify-center gap-2 disabled:opacity-50 sm:w-auto"
              disabled={busy || !confirmed || !canTransfer} onClick={() => void load(selected, true)}>
              {busy ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Upload size={16} className="shrink-0" />}
              {summary?.canRetry ? "Повторить передачу" : "Передать видео в TikTok"}
            </button>
            <button type="button" className="neu-btn flex min-h-11 w-full items-center justify-center gap-2 sm:w-auto"
              disabled={busy} onClick={() => selected ? void load(selected) : void refreshLibrary()}>
              <RefreshCw size={16} className="shrink-0" />Обновить статус
            </button>
            {selected ? <button type="button" className="neu-btn flex min-h-11 w-full items-center justify-center gap-2 sm:w-auto"
              disabled={busy} onClick={() => void refreshLibrary()}><RefreshCw size={16} className="shrink-0" />Обновить библиотеку</button> : null}
          </div>
          <p className="mt-2 text-xs text-[#64748B]">Кампания не создаётся. Расход бюджета не включён.</p>
        </>
      )}
    </div>
  );
}
