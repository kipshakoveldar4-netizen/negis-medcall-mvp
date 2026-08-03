import { useCallback, useEffect, useState } from "react";
import { MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { crmFetch } from "@/lib/api";

// The clinic's WhatsApp connection, in the clinic's own words.
//
// Behind it are two providers feeding one inbound pipeline — the Wazzup bridge
// and the official WhatsApp Cloud API — but a clinic does not care which one
// carried the message. It cares whether WhatsApp is on, how many enquiries it
// brought, and how to switch it off. So this renders one list, labelled by
// what the clinic gets rather than by our integration history.
//
// Nothing here shows patient data: the server returns counters and a masked
// channel key, never a message, a name or a phone.

type Channel = {
  id: string;
  provider: "wazzup" | "whatsapp_cloud";
  keyMasked: string;
  enabled: boolean;
  createdAt: string | null;
  leadsFiled: number;
  repeatsSeen: number;
  lastInboundAt: string | null;
};

type ProviderAvailability = { provider: Channel["provider"]; available: boolean };

const PROVIDER_LABEL: Record<Channel["provider"], string> = {
  wazzup: "через Wazzup",
  whatsapp_cloud: "напрямую от WhatsApp",
};

function formatMoment(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function WhatsAppChannels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [providers, setProviders] = useState<ProviderAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await crmFetch("/api/crm/whatsapp-channels");
      const body = (await response.json()) as {
        success?: boolean;
        data?: { channels?: Channel[]; providers?: ProviderAvailability[] };
      };
      if (!response.ok || body.success !== true) {
        // Security-2F honesty: a refused read is not an empty clinic.
        setFailed(true);
        return;
      }
      setChannels(Array.isArray(body.data?.channels) ? body.data.channels : []);
      setProviders(Array.isArray(body.data?.providers) ? body.data.providers : []);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (channel: Channel) => {
    setBusyId(channel.id);
    const next = !channel.enabled;
    try {
      const response = await crmFetch("/api/crm/whatsapp-channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, provider: channel.provider, enabled: next }),
      });
      const body = (await response.json()) as { success?: boolean };
      if (!response.ok || body.success !== true) {
        toast.error("Не удалось изменить канал. Попробуйте ещё раз.");
        return;
      }
      setChannels((current) => current.map((entry) => (entry.id === channel.id ? { ...entry, enabled: next } : entry)));
      toast.success(next ? "Канал включён — заявки снова создаются." : "Канал выключен — новые заявки не создаются.");
    } catch {
      toast.error("Не удалось изменить канал. Попробуйте ещё раз.");
    } finally {
      setBusyId(null);
    }
  };

  const cloudAvailable = providers.find((entry) => entry.provider === "whatsapp_cloud")?.available !== false;

  return (
    <div className="space-y-5">
      <section className="neu-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-[#0F172A]">WhatsApp: заявки от пациентов</h2>
          <p className="text-sm text-[#64748B]">
            Сообщение пациента на номер клиники автоматически становится заявкой в разделе «Заявки».
            Повторное сообщение с того же номера новую заявку не создаёт.
          </p>
        </div>
        <button type="button" className="neu-btn w-full sm:w-auto" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} />
          Обновить
        </button>
      </section>

      {failed && (
        <section className="neu-card border-l-4 border-l-[#DC2626]">
          <p className="text-sm text-[#0F172A]">
            Не удалось загрузить состояние каналов. Это ошибка чтения, а не отсутствие подключения — обновите страницу
            или повторите позже.
          </p>
        </section>
      )}

      {!failed && !loading && channels.length === 0 && (
        <section className="neu-card">
          <p className="text-sm text-[#0F172A]">WhatsApp пока не подключён к этой клинике.</p>
          <p className="mt-2 text-sm text-[#64748B]">
            Подключение выполняет администратор платформы: номер клиники привязывается к вашему рабочему пространству,
            после чего входящие сообщения начинают попадать в «Заявки». Обратитесь в поддержку — подключение занимает
            один шаг.
          </p>
          {!cloudAvailable && (
            <p className="mt-2 text-xs text-[#94A3B8]">
              Прямое подключение к WhatsApp на этой базе ещё не активировано.
            </p>
          )}
        </section>
      )}

      {channels.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {channels.map((channel) => (
            <section key={`${channel.provider}:${channel.id}`} className="neu-card">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ECFDF5] text-[#059669]">
                    <MessageCircle size={18} />
                  </span>
                  <div>
                    <p className="font-black text-[#0F172A]">WhatsApp {channel.keyMasked}</p>
                    <p className="text-xs text-[#64748B]">{PROVIDER_LABEL[channel.provider]}</p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    channel.enabled ? "bg-[#ECFDF5] text-[#059669]" : "bg-[#F1F5F9] text-[#64748B]"
                  }`}
                >
                  {channel.enabled ? "Приём включён" : "Выключен"}
                </span>
              </div>

              <dl className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <dt className="text-xs text-[#64748B]">Заявок</dt>
                  <dd className="text-lg font-black text-[#0F172A]">{channel.leadsFiled}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B]">Повторных</dt>
                  <dd className="text-lg font-black text-[#0F172A]">{channel.repeatsSeen}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B]">Последнее</dt>
                  <dd className="text-sm font-bold text-[#0F172A]">{formatMoment(channel.lastInboundAt)}</dd>
                </div>
              </dl>

              <button
                type="button"
                className="neu-btn mt-4 w-full"
                disabled={busyId === channel.id}
                onClick={() => void toggle(channel)}
              >
                {channel.enabled ? "Выключить приём заявок" : "Включить приём заявок"}
              </button>
              {channel.enabled && (
                <p className="mt-2 text-xs text-[#94A3B8]">
                  Выключение останавливает создание заявок. Сообщения пациентов при этом продолжают приходить в сам
                  WhatsApp.
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
