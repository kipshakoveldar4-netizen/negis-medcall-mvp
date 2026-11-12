import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, RefreshCw } from "lucide-react";
import type { TikTokConnectionSummary } from "../../../../../lib/tiktok/connections";

type Props = {
  enabled: boolean;
  request: (save: boolean, signal: AbortSignal) => Promise<TikTokConnectionSummary>;
  onChanged: () => void;
};

export function TikTokConnection({ enabled, request, onChanged }: Props) {
  const [result, setResult] = useState<TikTokConnectionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ request, onChanged });
  callbacks.current = { request, onChanged };

  async function load(save: boolean) {
    if (!enabled) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      const data = await callbacks.current.request(save, current.signal);
      if (current.signal.aborted) return;
      setResult(data);
      if (save) callbacks.current.onChanged();
    } catch (error) {
      if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "Не удалось проверить подключение TikTok.");
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    if (enabled) void load(false);
    return () => controller.current?.abort();
  }, [enabled]);

  return (
    <div className="my-5 min-w-0 border-y border-[#E2E8F0] py-4" data-testid="tiktok-workspace-connection">
      <h3 className="text-sm font-bold text-[#0F172A]">Рекламный аккаунт клиники</h3>
      {!enabled ? <p className="mt-2 text-sm text-[#64748B]">Для подключения нужен подтверждённый админ-доступ.</p> : (
        <>
          <div className="mt-2 min-w-0 break-words text-sm" aria-live="polite">
            {busy ? <p className="text-[#64748B]">Проверяем подключение…</p> : null}
            {message ? <p role="alert" className="text-amber-800">{message}</p> : null}
            {result ? (
              <>
                <p className={result.state === "connected" ? "text-emerald-800" : "text-[#64748B]"}>{result.message}</p>
                {result.saved ? <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-3">
                  <div><dt className="text-[#64748B]">Аккаунт</dt><dd>{result.maskedAdvertiserId}</dd></div>
                  <div><dt className="text-[#64748B]">Валюта</dt><dd>{result.currency}</dd></div>
                  <div><dt className="text-[#64748B]">Часовой пояс</dt><dd>{result.timezone}</dd></div>
                </dl> : null}
                {result.verifiedAt ? <p className="mt-2 text-xs text-[#64748B]">Последняя проверка: {new Date(result.verifiedAt).toLocaleString("ru-RU")}</p> : null}
              </>
            ) : null}
          </div>
          <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
            <button type="button" className="neu-btn flex min-h-11 w-full items-center justify-center gap-2 sm:w-auto"
              disabled={busy || !result || result.state === "disabled" || result.state === "configuration_changed"}
              onClick={() => void load(true)}>
              {busy ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Link2 size={16} className="shrink-0" />}
              {result?.saved ? "Проверить подключение" : "Подключить аккаунт к клинике"}
            </button>
            <button type="button" aria-label="Обновить статус подключения" title="Обновить статус подключения"
              className="neu-btn flex h-11 w-11 shrink-0 items-center justify-center" disabled={busy} onClick={() => void load(false)}>
              <RefreshCw size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
