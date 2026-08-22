import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";

import { crmFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import {
  describePushSupport,
  explainPushSupport,
  readThisDeviceSubscription,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "@/lib/push";

// Включение уведомлений на этом устройстве.
//
// Экран показывает СОСТОЯНИЕ, а не кнопку. Пуш молчит одинаково во всех случаях
// — разрешение не дано, айфон открыт в браузере вместо установленного
// приложения, подписка протухла, ключи не настроены, — и человек, уверенный,
// что уведомления включены, пропускает запись и винит приложение.

interface DeviceRow {
  id: string;
  endpointTail: string;
  label: string;
  lastSuccessAt: string;
  revoked: boolean;
  gone: boolean;
}

export function PushSettings() {
  const { clinicId, isImpersonation, isDemoMode } = useAuth();
  const [support] = useState(() => describePushSupport());
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [publicKey, setPublicKey] = useState("");
  const [available, setAvailable] = useState(true);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [busy, setBusy] = useState(false);

  // Под имперсонацией ничего не пишем: сессия принадлежит владельцу платформы,
  // и подписать его телефон именем сотрудника клиники нельзя. Тот же запрет уже
  // действует в этом диалоге для имени и пароля.
  const readOnly = isImpersonation || isDemoMode || !clinicId;

  const load = useCallback(async () => {
    if (readOnly) return;
    try {
      const response = await crmFetch(`/api/crm/push-subscriptions?workspaceId=${encodeURIComponent(clinicId ?? "")}`);
      const payload = (await response.json()) as {
        devices?: DeviceRow[];
        vapidPublicKey?: string;
        available?: boolean;
      };
      setDevices(payload.devices ?? []);
      setPublicKey(payload.vapidPublicKey ?? "");
      setAvailable(payload.available !== false);
      setSubscribedHere(Boolean(await readThisDeviceSubscription()));
    } catch {
      // Не прочиталось — показываем состояние «неизвестно», а не «выключено».
      setAvailable(true);
    }
  }, [clinicId, readOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = async () => {
    setBusy(true);
    try {
      const subscription = await subscribeThisDevice(publicKey);
      const response = await crmFetch(`/api/crm/push-subscriptions?workspaceId=${encodeURIComponent(clinicId ?? "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || "Не удалось включить уведомления");
      toast.success("Уведомления включены на этом устройстве");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось включить уведомления");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const endpoint = await unsubscribeThisDevice();
      if (endpoint) {
        await crmFetch(`/api/crm/push-subscriptions?workspaceId=${encodeURIComponent(clinicId ?? "")}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      }
      setSubscribedHere(false);
      toast.success("Уведомления выключены на этом устройстве");
      await load();
    } catch {
      toast.error("Не удалось выключить уведомления");
    } finally {
      setBusy(false);
    }
  };

  const otherDevices = devices.filter((device) => !device.revoked && !device.gone).length;

  return (
    <div className="border-t pt-4" style={{ borderColor: "var(--negis-border)" }}>
      <div className="mb-3 flex items-center gap-2">
        <Bell size={13} aria-hidden style={{ color: "var(--negis-muted)" }} />
        <span className="text-[11px] font-medium" style={{ color: "var(--negis-muted)" }}>
          УВЕДОМЛЕНИЯ О ЗАПИСЯХ
        </span>
      </div>

      {readOnly ? (
        <p className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
          Уведомления включаются под своей учётной записью сотрудника.
        </p>
      ) : !available ? (
        <p className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
          Уведомления ещё не включены в системе: нужна миграция 044. До неё подписать устройство нельзя.
        </p>
      ) : !publicKey ? (
        <p className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
          Уведомления ещё не настроены владельцем. Как только ключи появятся, здесь можно будет их включить.
        </p>
      ) : support !== "ok" ? (
        <p className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
          {explainPushSupport(support)}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
            {subscribedHere
              ? "На этом устройстве уведомления включены: придёт новая запись к вам и отмена вашей записи."
              : "Включите, чтобы получать новую запись и отмену сразу, не открывая приложение."}
          </p>
          <button
            type="button"
            className={subscribedHere ? "neu-btn w-full justify-center px-4 py-2 text-sm" : "neu-btn-primary w-full justify-center px-4 py-2 text-sm"}
            disabled={busy}
            onClick={() => void (subscribedHere ? disable() : enable())}
          >
            {subscribedHere ? <BellOff size={14} /> : <Bell size={14} />}
            {busy ? "Секунду…" : subscribedHere ? "Выключить на этом устройстве" : "Включить уведомления"}
          </button>
          {otherDevices > 1 ? (
            <p className="text-[11px]" style={{ color: "var(--negis-muted)" }}>
              Всего устройств с уведомлениями: {otherDevices}.
            </p>
          ) : null}
          {subscribedHere && devices.every((device) => !device.lastSuccessAt) ? (
            // Разрешение можно отозвать в настройках телефона, и приложение об
            // этом не узнает. Отметка об успешной доставке — единственный
            // честный признак, что канал живой.
            <p className="text-[11px]" style={{ color: "var(--negis-muted)" }}>
              Ни одно уведомление ещё не доставлено — это нормально, пока не было новых записей.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
