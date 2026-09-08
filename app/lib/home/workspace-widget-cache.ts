import 'server-only';

type CacheEntry<T> = {
  data: T;
  cachedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
};

export type CachedWidgetResult<T> = {
  data: T;
  cachedAt: string;
  stale: boolean;
};

const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<CacheEntry<unknown>>>();

function trimCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...cache.entries()]
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
    .slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of oldest) cache.delete(key);
}

async function refreshEntry<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<CacheEntry<T>> {
  const existing = inFlight.get(key) as Promise<CacheEntry<T>> | undefined;
  if (existing) return existing;
  const pending = load().then((data) => {
    const now = Date.now();
    const entry: CacheEntry<T> = { data, cachedAt: now, expiresAt: now + ttlMs, lastAccessedAt: now };
    cache.set(key, entry);
    trimCache();
    return entry;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, pending as Promise<CacheEntry<unknown>>);
  return pending;
}

function publicResult<T>(entry: CacheEntry<T>, stale: boolean): CachedWidgetResult<T> {
  entry.lastAccessedAt = Date.now();
  return { data: entry.data, cachedAt: new Date(entry.cachedAt).toISOString(), stale };
}

export async function loadCachedWorkspaceWidget<T>(input: {
  userId: string;
  workspaceId: string;
  widget: string;
  ttlMs: number;
  forceRefresh?: boolean;
  load: () => Promise<T>;
}): Promise<CachedWidgetResult<T>> {
  const key = `${input.userId}\0${input.workspaceId}\0${input.widget}`;
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  if (existing && !input.forceRefresh && existing.expiresAt > now) return publicResult(existing, false);

  if (existing && !input.forceRefresh) {
    void refreshEntry(key, input.ttlMs, input.load).catch(() => {
      console.warn('[Home widgets] Background refresh failed.', { widget: input.widget });
    });
    return publicResult(existing, true);
  }

  try {
    return publicResult(await refreshEntry(key, input.ttlMs, input.load), false);
  } catch (error) {
    if (existing) return publicResult(existing, true);
    throw error;
  }
}
