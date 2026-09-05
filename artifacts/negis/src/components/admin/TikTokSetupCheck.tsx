import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { TikTokSetupSummary } from "../../../../../lib/tiktok/setup";

type Props = {
  enabled: boolean;
  city: string;
  check: (signal: AbortSignal) => Promise<TikTokSetupSummary>;
  onChecked: () => void;
};

export function TikTokSetupCheck({ enabled, city, check, onChecked }: Props) {
  const [result, setResult] = useState<TikTokSetupSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    setExpired(false);
    if (!result) return;
    const timeout = setTimeout(() => setExpired(true), Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [result]);

  async function verify() {
    if (!enabled || busy || !city.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    setResult(null);
    try {
      const summary = await check(controller.signal);
      if (!controller.signal.aborted) {
        setResult(summary);
        onChecked();
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="mt-5 min-w-0 border-y border-[#E2E8F0] py-4" data-testid="tiktok-setup-check">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-bold text-[#0F172A]">Город и рекламный профиль</h3>
        <button type="button" className="neu-btn flex min-h-11 w-full items-center justify-center gap-2 sm:w-[260px]"
          disabled={!enabled || busy || !city.trim()} onClick={() => void verify()}>
          {busy ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <RefreshCw size={16} className="shrink-0" />}
          {busy ? "Проверяем TikTok…" : "Проверить город и профиль"}
        </button>
      </div>
      {!enabled ? <p className="mt-2 text-sm text-[#64748B]">Для проверки нужен подтверждённый админ-доступ.</p> : null}
      {failed ? <p role="alert" className="mt-3 break-words text-sm text-amber-800">Не удалось проверить TikTok. Повторите позже.</p> : null}
      {expired && enabled ? <p className="mt-3 text-sm text-amber-800">Подтверждение устарело. Проверьте город и профиль заново.</p> : null}
      {result && enabled && !expired ? (
        <div aria-live="polite" className="mt-3 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 break-words">
            <p className="flex items-center gap-2 font-semibold text-[#0F172A]">
              {result.city.status === "verified" ? <CheckCircle2 size={16} className="shrink-0 text-emerald-700" /> : null}
              Город: {result.city.name}
            </p>
            <p className="mt-1 text-[#64748B]">{result.city.message}</p>
          </div>
          <div className="min-w-0 break-words">
            <p className="flex items-center gap-2 font-semibold text-[#0F172A]">
              {result.identity.status === "verified" ? <CheckCircle2 size={16} className="shrink-0 text-emerald-700" /> : null}
              Рекламный профиль
            </p>
            <p className="mt-1 text-[#64748B]">{result.identity.message}</p>
          </div>
          <p className="text-xs text-[#64748B] sm:col-span-2">
            Проверено {new Date(result.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
            {" "}Подтверждение действует до {new Date(result.expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
          </p>
        </div>
      ) : null}
    </div>
  );
}
