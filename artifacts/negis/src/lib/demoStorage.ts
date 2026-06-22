import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

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

function readWorkspaceId(): string {
  if (typeof window === "undefined") return "demo-workspace";

  try {
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

async function safeJson<TData>(response: globalThis.Response): Promise<ApiResponse<TData> | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as ApiResponse<TData>;
  } catch {
    return null;
  }
}

export function useDemoCollection<TItem extends { id: string }>(
  key: string,
  seed: TItem[],
  options: ApiCollectionOptions<TItem> = {},
) {
  const [items, setItems] = useState<TItem[]>(seed);
  const {
    endpoint,
    listKey = "items",
    itemKey = "item",
    toApi,
    patchToApi,
    fromApi,
  } = options;

  useEffect(() => {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    const saved = raw ? readDemoStorage<TItem[] | null>(key, null) : null;
    const nextItems = Array.isArray(saved) && saved.length > 0 ? saved : seed;
    setItems(nextItems);
    if (!raw || !Array.isArray(saved) || saved.length === 0) {
      writeDemoStorage(key, nextItems);
    }
  }, [key, seed]);

  useEffect(() => {
    if (!endpoint) return;

    let cancelled = false;

    const loadFromApi = async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await fetch(apiUrl(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`));
        const body = await safeJson<Record<string, unknown>>(response);

        if (
          cancelled ||
          !response.ok ||
          body?.success !== true ||
          body.mode !== "supabase"
        ) {
          return;
        }

        const rawItems = body.data[listKey];
        if (!Array.isArray(rawItems)) return;

        const mapped = rawItems.map((item) => (fromApi ? fromApi(item) : (item as TItem)));
        setItems(mapped);
        writeDemoStorage(key, mapped);
      } catch {
        // Keep localStorage seed/data as the offline fallback.
      }
    };

    void loadFromApi();

    return () => {
      cancelled = true;
    };
  }, [endpoint, fromApi, key, listKey, seed]);

  const setStoredItems = (next: TItem[] | ((current: TItem[]) => TItem[])) => {
    setItems((current) => {
      const value = typeof next === "function" ? next(current) : next;
      writeDemoStorage(key, value);
      return value;
    });
  };

  const addItem = (item: TItem) => {
    setStoredItems((current) => [item, ...current]);

    if (!endpoint) return;

    void (async () => {
      try {
        const workspaceId = readWorkspaceId();
        const payload = {
          ...(toApi ? toApi(item) : item),
          workspaceId,
        };
        const response = await fetch(apiUrl(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await safeJson<Record<string, unknown>>(response);
        if (!response.ok || body?.success !== true || body.mode !== "supabase") return;

        const rawItem = body.data[itemKey];
        if (!rawItem) return;

        const savedItem = fromApi ? fromApi(rawItem) : (rawItem as TItem);
        setStoredItems((current) => current.map((currentItem) => (currentItem.id === item.id ? savedItem : currentItem)));
      } catch {
        // Local optimistic item remains saved in localStorage.
      }
    })();
  };

  const updateItem = (id: string, patch: Partial<TItem>) => {
    setStoredItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

    if (!endpoint) return;

    void (async () => {
      try {
        const workspaceId = readWorkspaceId();
        await fetch(apiUrl(endpoint), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            workspaceId,
            updates: patchToApi ? patchToApi(patch) : patch,
          }),
        });
      } catch {
        // Local optimistic patch remains saved in localStorage.
      }
    })();
  };

  return { items, setItems: setStoredItems, addItem, updateItem };
}
