import { useEffect, useState } from "react";

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

export function useDemoCollection<TItem extends { id: string }>(key: string, seed: TItem[]) {
  const [items, setItems] = useState<TItem[]>(seed);

  useEffect(() => {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    const saved = raw ? readDemoStorage<TItem[] | null>(key, null) : null;
    const nextItems = Array.isArray(saved) && saved.length > 0 ? saved : seed;
    setItems(nextItems);
    if (!raw || !Array.isArray(saved) || saved.length === 0) {
      writeDemoStorage(key, nextItems);
    }
  }, [key, seed]);

  const setStoredItems = (next: TItem[] | ((current: TItem[]) => TItem[])) => {
    setItems((current) => {
      const value = typeof next === "function" ? next(current) : next;
      writeDemoStorage(key, value);
      return value;
    });
  };

  const addItem = (item: TItem) => setStoredItems((current) => [item, ...current]);

  const updateItem = (id: string, patch: Partial<TItem>) =>
    setStoredItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  return { items, setItems: setStoredItems, addItem, updateItem };
}
