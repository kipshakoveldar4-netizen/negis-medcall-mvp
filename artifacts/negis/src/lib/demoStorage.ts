import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { crmFetch } from "@/lib/api";

type ApiCollectionOptions<TItem extends { id: string }> = {
  endpoint?: string;
  listKey?: string;
  itemKey?: string;
  toApi?: (item: TItem) => Record<string, unknown>;
  patchToApi?: (patch: Partial<TItem>) => Record<string, unknown>;
  fromApi?: (item: unknown) => TItem;
};

type ApiResponse<TData> =
  | {
      success: true;
      mode?: string;
      warning?: string;
      data: TData;
    }
  | {
      success: false;
      error: string;
      details?: string[];
    };

export function readDemoStorage<TValue>(key: string, fallback: TValue): TValue {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as TValue;
  } catch {
    return fallback;
  }
}

export function writeDemoStorage<TValue>(key: string, value: TValue) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

/**
 * Where AuthContext stores the workspace it resolved from /api/crm/auth-context.
 *
 * Security-2B made the server the sole tenant authority, and the bootstrap no
 * longer writes the old negis_staff_user / negis_staff_session blobs. Reading
 * those first therefore fell through to "demo-workspace" for a signed-in user
 * and every CRM request came back 403. The verified selector is checked first;
 * the legacy keys stay only so demo mode keeps working.
 */
export const WORKSPACE_SELECTOR_KEY = "negis_workspace_selector";

export function readWorkspaceId(): string {
  if (typeof window === "undefined") return "demo-workspace";

  try {
    const verified = window.localStorage.getItem(WORKSPACE_SELECTOR_KEY);
    if (typeof verified === "string" && verified.trim()) return verified.trim();

    const staffUserRaw = window.localStorage.getItem("negis_staff_user");
    if (staffUserRaw) {
      const staffUser = JSON.parse(staffUserRaw) as { workspaceId?: unknown; workspace_id?: unknown };
      const staffWorkspaceId = typeof staffUser.workspaceId === "string" && staffUser.workspaceId.trim()
        ? staffUser.workspaceId.trim()
        : typeof staffUser.workspace_id === "string" && staffUser.workspace_id.trim()
          ? staffUser.workspace_id.trim()
          : "";
      if (staffWorkspaceId) return staffWorkspaceId;
    }

    const staffSessionRaw = window.localStorage.getItem("negis_staff_session");
    if (staffSessionRaw) {
      const staffSession = JSON.parse(staffSessionRaw) as { workspaceId?: unknown };
      if (typeof staffSession.workspaceId === "string" && staffSession.workspaceId.trim()) {
        return staffSession.workspaceId.trim();
      }
    }

    const raw = window.localStorage.getItem("negis_demo_workspace");
    if (!raw) return "demo-workspace";
    const workspace = JSON.parse(raw) as { id?: unknown };
    return typeof workspace.id === "string" && workspace.id.trim() ? workspace.id.trim() : "demo-workspace";
  } catch {
    return "demo-workspace";
  }
}

/**
 * Selection-2: a localStorage key that holds one clinic's data, bound to that
 * clinic.
 *
 * These caches were written when a browser could only ever be in one workspace:
 * the selector was set by redeeming an invitation and nothing could change it,
 * so nothing could cross. Selection-1 made switching possible, and an unscoped
 * key then carried the previous clinic's data into the next one — a patient's
 * name and phone into another clinic's appointment form, or one clinic's
 * WhatsApp destination into another clinic's campaign brief.
 *
 * Scoping rather than clearing on switch keeps each clinic's own draft intact
 * when the user switches back.
 */
export function workspaceScopedKey(key: string): string {
  return `${key}::${readWorkspaceId()}`;
}

// Same discriminator as the server (lib/crm/server.ts isUuid): a UUID workspace is
// Supabase-backed production; anything else ("demo-workspace") is local demo mode.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRealWorkspace(workspaceId: string = readWorkspaceId()): boolean {
  return UUID_PATTERN.test(workspaceId);
}

async function safeJson<TData>(response: globalThis.Response): Promise<ApiResponse<TData> | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as ApiResponse<TData>;
  } catch {
    return null;
  }
}

/**
 * The last successful production read of each list, so a page transition paints
 * the previous answer immediately instead of a skeleton while the same list is
 * fetched again — a round trip that measured 0.7–2.4s per collection on
 * production, several collections per page. The refresh still happens on every
 * mount; the cache only decides what is on screen while it runs.
 *
 * Scope and honesty rules:
 *   - The key is endpoint + workspace: one clinic's rows can never appear on
 *     another clinic's page, and a workspace switch is a cache miss by
 *     construction (Selection-2 stays intact).
 *   - Raw API rows are cached, not mapped items: pages that read the same
 *     endpoint with different `fromApi` mappers each map for themselves.
 *   - Only a successful mode:"supabase" answer is ever cached, and the cache
 *     lives in module memory — nothing here touches the demo localStorage keys.
 *   - A failed refresh still calls reportLoadFailure(): showing recent data
 *     does not excuse hiding that the current read was refused.
 */
type CachedList = { rows: unknown[]; at: number };
const listReadCache = new Map<string, CachedList>();
const LIST_READ_TTL_MS = 60_000;

function listCacheKey(endpoint: string, workspaceId: string): string {
  return `${endpoint}::${workspaceId}`;
}

function readFreshListCache(endpoint: string, workspaceId: string): unknown[] | null {
  const entry = listReadCache.get(listCacheKey(endpoint, workspaceId));
  if (!entry) return null;
  if (Date.now() - entry.at > LIST_READ_TTL_MS) return null;
  return entry.rows;
}

export function useDemoCollection<TItem extends { id: string }>(
  key: string,
  seed: TItem[],
  options: ApiCollectionOptions<TItem> = {},
) {
  // Options are configuration, captured once. Pages pass them as inline
  // literals, so their identity changes on every render; treating them as
  // reactive dependencies turned the refresh effect into a loop — the fetch
  // settled, setItems rendered, the new fromApi identity re-armed the effect,
  // and the same list was requested again, forever, at roughly one request per
  // response time. Measured on production: /api/crm/clients every ~700ms for
  // as long as the clients page stayed open. Whether a page's mapper happened
  // to be a module constant (LeadsPage) or an inline arrow (ClientsPage)
  // decided whether it looped — a distinction no caller should have to know
  // exists.
  const stable = useRef({ seed, ...options }).current;
  const {
    endpoint,
    listKey = "items",
    itemKey = "item",
    toApi,
    patchToApi,
    fromApi,
  } = stable;

  // Selection-2: which clinic this collection belongs to, read on every render
  // so that a workspace change is a change of dependency and not a silent one.
  //
  // The effect below used to call readWorkspaceId() inside itself while
  // depending on nothing that moves when the workspace does. Today the switch
  // unmounts the page — ProtectedPage renders null the moment permissions are
  // cleared — so a stale list never reached the screen. That is a property of a
  // component two files away, and not something this hook should be relying on
  // to keep one clinic's records off another clinic's page.
  const workspaceId = readWorkspaceId();

  // Production = UUID workspace with an API-backed collection: never render demo
  // seeds, never read/write the negis_demo_* localStorage cache, and never fall
  // back to demo data. Demo workspaces keep the original behavior untouched.
  const [productionMode] = useState(() => Boolean(endpoint) && isRealWorkspace());
  const [items, setItems] = useState<TItem[]>(() => {
    if (!productionMode) return stable.seed;
    const cached = endpoint ? readFreshListCache(endpoint, workspaceId) : null;
    if (!cached) return [];
    return cached.map((row) => (fromApi ? fromApi(row) : (row as TItem)));
  });
  // loaded: demo mode is ready immediately; production paints a fresh cached
  // read at once and refreshes behind it, or waits for the first API settle.
  const [loaded, setLoaded] = useState(
    () => !productionMode || (Boolean(endpoint) && readFreshListCache(endpoint as string, workspaceId) !== null),
  );
  // A failed production read was the last silent failure left: the server has
  // answered 502 since the failure-honesty change, but this hook dropped the
  // answer and the page showed an empty clinic. Refused writes already speak
  // through revertWrite's toast; a refused read now speaks the same way, and
  // loadError is exposed for any page that wants to render more than a toast.
  const [loadError, setLoadError] = useState(false);

  const reportLoadFailure = () => {
    // Demo mode owns its localStorage copy: an unreachable API is the normal
    // state there, not a failure worth announcing.
    if (!productionMode) return;
    setLoadError(true);
    // One toast per page, not one per collection — several lists load at once
    // and sonner dedupes by id.
    toast.error("Не удалось загрузить данные. Обновите страницу или повторите попытку позже.", {
      id: "crm-load-failed",
    });
  };

  useEffect(() => {
    if (productionMode) return;
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    const saved = raw ? readDemoStorage<TItem[] | null>(key, null) : null;
    const nextItems = Array.isArray(saved) && saved.length > 0 ? saved : stable.seed;
    setItems(nextItems);
    if (!raw || !Array.isArray(saved) || saved.length === 0) {
      writeDemoStorage(key, nextItems);
    }
    // stable is captured once by design — see the useRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, productionMode]);

  useEffect(() => {
    if (!endpoint) return;

    let cancelled = false;

    const loadFromApi = async () => {
      try {
        const response = await crmFetch(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const body = await safeJson<Record<string, unknown>>(response);

        if (cancelled) return;

        if (!response.ok || body?.success !== true || body.mode !== "supabase") {
          // Production stays empty — no demo fallback — but no longer silent.
          reportLoadFailure();
          return;
        }

        const rawItems = body.data[listKey];
        if (!Array.isArray(rawItems)) return;

        // Only a confirmed supabase answer is worth remembering; the raw rows
        // go in so every consumer keeps applying its own fromApi.
        if (productionMode) {
          listReadCache.set(listCacheKey(endpoint, workspaceId), { rows: rawItems, at: Date.now() });
        }

        const mapped = rawItems.map((item) => (fromApi ? fromApi(item) : (item as TItem)));
        setItems(mapped);
        setLoadError(false);
        // Supabase data must never be cached into the demo localStorage keys.
        if (!productionMode) writeDemoStorage(key, mapped);
      } catch {
        // Demo keeps localStorage seed/data as the offline fallback.
        if (!cancelled) reportLoadFailure();
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    void loadFromApi();

    return () => {
      cancelled = true;
    };
    // The dependencies are the identity of the data — which list, which
    // clinic — never the identity of caller-supplied functions. A mapper
    // recreated on each render must not be able to re-arm this effect: that
    // is exactly the refetch loop this hook once had.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, key, productionMode, workspaceId]);

  /**
   * Security-2F: an optimistic row that the server refused must not stay.
   *
   * Every write here paints the row first and then posts it. The server used to
   * answer a failed production write with 200 and a demo item, and this hook
   * dropped anything that was not mode "supabase" on the floor — so the row sat
   * on screen, was never saved, and disappeared on the next load. The server
   * now reports the failure; this puts the list back and says so.
   *
   * Demo mode is untouched: there the localStorage copy is the record, and a
   * demo response is the expected answer rather than a failure.
   */
  const revertWrite = (restore: (current: TItem[]) => TItem[]) => {
    if (!productionMode) return;
    setStoredItems(restore);
    toast.error("Не удалось сохранить. Изменение отменено, повторите попытку.");
  };

  const setStoredItems = (next: TItem[] | ((current: TItem[]) => TItem[])) => {
    // Any local write makes the cached read stale — including a rollback, whose
    // outcome the cache has no way to know. The next mount fetches fresh rather
    // than briefly resurrecting a list from before the write.
    if (productionMode && endpoint) listReadCache.delete(listCacheKey(endpoint, workspaceId));
    setItems((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (!productionMode) writeDemoStorage(key, value);
      return value;
    });
  };

  /**
   * Возвращает, СОХРАНИЛ ли сервер запись.
   *
   * Раньше это был fire-and-forget: строка появлялась на экране, форма
   * закрывалась, а отказ приходил секундой позже — список откатывался, но
   * введённое сотрудником уже было стёрто вместе с формой, и набирать всё
   * приходилось заново. Экран, который дождётся ответа, может оставить форму
   * открытой. Прежние вызывающие без await продолжают работать как раньше.
   */
  const addItem = (item: TItem): Promise<boolean> => {
    setStoredItems((current) => [item, ...current]);

    // Демо-режим: localStorage и есть запись, отказу неоткуда взяться.
    if (!endpoint) return Promise.resolve(true);

    return (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const payload = {
          ...(toApi ? toApi(item) : item),
          workspaceId,
        };
        const response = await crmFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await safeJson<Record<string, unknown>>(response);
        if (!response.ok || body?.success !== true || body.mode !== "supabase") {
          revertWrite((current) => current.filter((entry) => entry.id !== item.id));
          return false;
        }

        const rawItem = body.data[itemKey];
        if (!rawItem) return true;

        const savedItem = fromApi ? fromApi(rawItem) : (rawItem as TItem);
        setStoredItems((current) => current.map((currentItem) => (currentItem.id === item.id ? savedItem : currentItem)));
        return true;
      } catch {
        revertWrite((current) => current.filter((entry) => entry.id !== item.id));
        return false;
      }
    })();
  };

  /** Возвращает, ПРИНЯЛ ли сервер правку — см. addItem. */
  const updateItem = (id: string, patch: Partial<TItem>): Promise<boolean> => {
    // Captured from this render rather than from inside the updater, so the
    // rollback does not depend on when React runs it.
    const previous = items.find((entry) => entry.id === id);
    setStoredItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

    if (!endpoint) return Promise.resolve(true);

    const restore = (current: TItem[]): TItem[] =>
      previous ? current.map((entry) => (entry.id === id ? previous : entry)) : current;

    return (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await crmFetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            workspaceId,
            updates: patchToApi ? patchToApi(patch) : patch,
          }),
        });
        const body = await safeJson<Record<string, unknown>>(response);
        // The patch used to be posted and forgotten, so a refused update looked
        // identical to an accepted one.
        if (!response.ok || body?.success !== true || body.mode !== "supabase") {
          revertWrite(restore);
          return false;
        }
        return true;
      } catch {
        revertWrite(restore);
        return false;
      }
    })();
  };

  return { items, loaded, loadError, setItems: setStoredItems, addItem, updateItem };
}
