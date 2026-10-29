import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";

import { crmFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { hasSupabaseFrontendEnv, supabase, sessionAuth } from "@/lib/supabase";
import { getSignOutRevision, isSignOutPending } from "@/lib/authSignOut";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeviceRow(value: unknown): value is DeviceRow {
  return isRecord(value) && typeof value.id === "string" && typeof value.endpointTail === "string"
    && typeof value.label === "string" && typeof value.lastSuccessAt === "string"
    && typeof value.revoked === "boolean" && typeof value.gone === "boolean";
}

function isPushState(value: unknown): value is { success: true; devices: DeviceRow[]; vapidPublicKey: string; available?: boolean } {
  return isRecord(value) && value.success === true && Array.isArray(value.devices) && value.devices.every(isDeviceRow)
    && typeof value.vapidPublicKey === "string" && (value.available === undefined || typeof value.available === "boolean");
}

type PushScope = {
  actor: string;
  workspace: string;
  allowed: boolean;
  active: boolean;
  retired: boolean;
  signOutRevision: number;
  requests: Set<AbortController>;
};

function retirePushScope(scope: PushScope) {
  scope.retired = true;
  for (const request of scope.requests) request.abort();
  scope.requests.clear();
}

function pushScopeCurrent(scope: PushScope) {
  return scope.active && !scope.retired && scope.allowed && !isSignOutPending()
    && getSignOutRevision() === scope.signOutRevision;
}

function usePushScope() {
  const { user, session, clinicId, isImpersonation, isDemoMode, isSigningOut } = useAuth();
  const [sdkRevision, setSdkRevision] = useState(0);
  // Под имперсонацией нельзя подписать телефон владельца платформы именем сотрудника.
  const readOnly = isImpersonation || isDemoMode || !clinicId || isSigningOut || !user?.id
    || session?.user.id !== user.id;
  const key = JSON.stringify([user?.id, session?.user.id, clinicId, readOnly, getSignOutRevision()]);
  const createScope = (): PushScope => ({ actor: user?.id || "", workspace: clinicId || "", allowed: !readOnly,
    active: false, retired: false, signOutRevision: getSignOutRevision(), requests: new Set() });
  const lifetime = useRef({ key, sdkRevision, sdkActor: user?.id || "", scope: createScope() });
  if (lifetime.current.key !== key || lifetime.current.sdkRevision !== sdkRevision) {
    retirePushScope(lifetime.current.scope);
    lifetime.current = { ...lifetime.current, key, sdkRevision, scope: createScope() };
  }
  const scope = lifetime.current.scope;
  // An SDK actor change retires callbacks synchronously, before a batched A/B/A render.
  useLayoutEffect(() => {
    if (!hasSupabaseFrontendEnv) return;
    let active = true;
    const { data: { subscription } } = sessionAuth.onAuthStateChange((_event, next) => {
      if (!active) return;
      const actor = next?.user.id || "";
      if (actor === lifetime.current.sdkActor) return;
      lifetime.current.sdkActor = actor;
      retirePushScope(lifetime.current.scope);
      setSdkRevision(value => value + 1);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      for (const request of scope.requests) request.abort();
      scope.requests.clear();
    };
  }, [scope]);
  return { scope, readOnly: readOnly || (hasSupabaseFrontendEnv && lifetime.current.sdkActor !== scope.actor) };
}

function pushRequest(scope: PushScope, abort: AbortController, init: RequestInit = {}) {
  return crmFetch(`/api/crm/push-subscriptions?workspaceId=${encodeURIComponent(scope.workspace)}`, {
    ...init, cache: "no-store", signal: abort.signal, expectedUserId: scope.actor,
    dispatchGuard: () => pushScopeCurrent(scope) && !abort.signal.aborted,
  });
}

/**
 * Самовосстановление подписки — шаг из чертёжа канала, который был отложен.
 *
 * Браузер может пересоздать подписку молча (переустановка, чистка данных), и
 * сервер тогда шлёт в мёртвый адрес: для мастера это выглядит как «уведомления
 * кончились». При каждой загрузке сверяем подписку устройства с сервером
 * идемпотентным POST — ключ (workspace, endpoint) делает повтор безвредным.
 * Ничего не спрашивает и не включает: только чинит то, что уже включали.
 */
export function PushSync() {
  const { clinicId, isImpersonation, isDemoMode } = useAuth();
  const { scope, readOnly } = usePushScope();
  useEffect(() => {
    if (isImpersonation || isDemoMode || !clinicId) return;
    if (readOnly || !pushScopeCurrent(scope)) return;
    if (describePushSupport() !== "ok") return;
    const abort = new AbortController();
    scope.requests.add(abort);
    void (async () => {
      try {
        const subscription = await readThisDeviceSubscription(() => pushScopeCurrent(scope) && !abort.signal.aborted);
        if (!pushScopeCurrent(scope) || abort.signal.aborted || !subscription) return;
        await pushRequest(scope, abort, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription),
        });
      } catch {
        // Молча: это фоновая сверка, ей нечего сказать человеку.
      } finally {
        scope.requests.delete(abort);
      }
    })();
    return () => {
      abort.abort();
      scope.requests.delete(abort);
    };
  }, [scope, readOnly, clinicId, isImpersonation, isDemoMode]);
  return null;
}

export function PushSettings() {
  const { scope, readOnly } = usePushScope();
  const [support] = useState(() => describePushSupport());
  const [snapshot, setSnapshot] = useState<{ scope: PushScope; devices: DeviceRow[]; publicKey: string;
    available: boolean; subscribedHere: boolean; error?: string } | null>(null);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const [busyScope, setBusyScope] = useState<PushScope | null>(null);
  const pending = useRef<{ scope: PushScope; abort: AbortController } | null>(null);
  const currentSnapshot = snapshot?.scope === scope ? snapshot : null;
  const devices = currentSnapshot?.devices ?? [];
  const publicKey = currentSnapshot?.publicKey ?? "";
  const available = currentSnapshot?.available ?? true;
  const subscribedHere = currentSnapshot?.subscribedHere ?? false;
  const busy = busyScope === scope;

  const load = useCallback(async () => {
    if (readOnly || !pushScopeCurrent(scope)) return;
    const abort = new AbortController();
    scope.requests.add(abort);
    const current = () => pushScopeCurrent(scope) && !abort.signal.aborted;
    try {
      const response = await pushRequest(scope, abort);
      if (!current()) return;
      if (!response.ok) throw new Error("Push state unavailable");
      const payload: unknown = await response.json();
      if (!current()) return;
      if (!isPushState(payload)) throw new Error("Invalid push state");
      const subscription = await readThisDeviceSubscription(current);
      if (!current()) return;
      setSnapshot({ scope, devices: payload.devices, publicKey: payload.vapidPublicKey,
        available: payload.available !== false, subscribedHere: Boolean(subscription) });
    } catch {
      if (current()) {
        latestSnapshot.current = null;
        setSnapshot({ scope, devices: [], publicKey: "", available: true, subscribedHere: false,
          error: "Не удалось проверить состояние устройств. Попробуйте позже." });
      }
    } finally {
      scope.requests.delete(abort);
    }
  }, [scope, readOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeSubscription = async (enable: boolean) => {
    if (readOnly || !pushScopeCurrent(scope) || !currentSnapshot || currentSnapshot !== latestSnapshot.current
      || currentSnapshot.error || !publicKey || !available || support !== "ok"
      || pending.current?.scope === scope) return;
    const operation = { scope, abort: new AbortController() };
    pending.current = operation;
    scope.requests.add(operation.abort);
    const current = () => pushScopeCurrent(scope) && pending.current === operation && !operation.abort.signal.aborted;
    let localUnsubscribeCompleted = false;
    setBusyScope(scope);
    try {
      if (enable) {
        const subscription = await subscribeThisDevice(publicKey, current);
        if (!current()) return;
        const response = await pushRequest(scope, operation.abort, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription),
        });
        if (!current()) return;
        const payload: unknown = await response.json();
        if (!current()) return;
        if (!response.ok || !isRecord(payload) || payload.success !== true) {
          throw new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : "Не удалось включить уведомления");
        }
        toast.success("Уведомления включены на этом устройстве");
      } else {
        const endpoint = await unsubscribeThisDevice(current);
        localUnsubscribeCompleted = true;
        if (!current()) return;
        if (endpoint) {
          const response = await pushRequest(scope, operation.abort, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }),
          });
          if (!current()) return;
          const payload: unknown = await response.json();
          if (!current()) return;
          if (!response.ok || !isRecord(payload) || payload.success !== true) throw new Error("Push revocation unconfirmed");
        }
        setSnapshot(value => value?.scope === scope ? { ...value, subscribedHere: false } : value);
        toast.success("Уведомления выключены на этом устройстве");
      }
      await load();
    } catch (error) {
      // The browser unsubscribe is not rolled back when server confirmation fails.
      if (current() && localUnsubscribeCompleted) setSnapshot(value => value?.scope === scope ? { ...value, subscribedHere: false } : value);
      if (current()) toast.error(enable && error instanceof Error ? error.message
        : enable ? "Не удалось включить уведомления" : localUnsubscribeCompleted
          ? "Не удалось подтвердить отключение устройства на сервере. Проверьте состояние позже."
          : "Не удалось выключить уведомления на этом устройстве.");
    } finally {
      scope.requests.delete(operation.abort);
      if (current()) {
        pending.current = null;
        setBusyScope(null);
      }
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
      ) : currentSnapshot?.error ? (
        <p role="alert" className="text-[12px]" style={{ color: "var(--negis-muted)" }}>
          {currentSnapshot.error}
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
            onClick={() => void changeSubscription(!subscribedHere)}
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
