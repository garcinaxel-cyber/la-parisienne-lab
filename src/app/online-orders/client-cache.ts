'use client';
// Tiny stale-while-revalidate cache for the online-sales screens (UI v2, 2026-11-14 — Axel: "le
// moins possible de chargement"). Lives in module memory for the browser tab: going back to a
// screen or a day already seen shows it instantly, then refreshes quietly in the background.
type Entry = { at: number; value: unknown; inflight?: Promise<unknown> };
const store = new Map<string, Entry>();

export function peek<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

// Calls onData with the cached value right away (if any), then with fresh data unless the cached
// value is younger than maxAgeMs. Concurrent calls for the same key share one request.
export async function swr<T>(key: string, fetcher: () => Promise<T>, onData: (v: T, fresh: boolean) => void, maxAgeMs = 30_000): Promise<void> {
  const e = store.get(key);
  if (e && e.value !== undefined) {
    onData(e.value as T, false);
    if (Date.now() - e.at < maxAgeMs) return;
  }
  const p = (e?.inflight as Promise<T> | undefined) ?? fetcher();
  store.set(key, { at: e?.at ?? 0, value: e?.value, inflight: p });
  try {
    const v = await p;
    store.set(key, { at: Date.now(), value: v });
    onData(v, true);
  } catch {
    const cur = store.get(key);
    if (cur) store.set(key, { at: cur.at, value: cur.value });
  }
}

// Warm the cache without rendering anything (e.g. tomorrow's orders).
export function prefetch<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = 30_000) {
  const e = store.get(key);
  if (e && (e.inflight || Date.now() - e.at < maxAgeMs)) return;
  void swr(key, fetcher, () => {}, maxAgeMs);
}

export function invalidate(prefix: string) {
  for (const k of Array.from(store.keys())) if (k.startsWith(prefix)) { const e = store.get(k)!; store.set(k, { at: 0, value: e.value }); }
}
