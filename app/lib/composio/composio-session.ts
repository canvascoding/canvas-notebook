import 'server-only';

import { getComposio, resetComposioInstance } from './composio-client';
import { composioContextCacheKey, type ResolvedComposioContext } from './composio-context';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionCache = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioSession(context: ResolvedComposioContext): Promise<any | null> {
  const composio = await getComposio(context.storageScope);
  if (!composio) return null;
  const cacheKey = composioContextCacheKey(context);

  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey)!;
  }

  try {
    const session = await composio.create(context.composioUserId);
    sessionCache.set(cacheKey, session);
    return session;
  } catch (error) {
    console.error('[Composio] Failed to create session:', error);
    return null;
  }
}

export function resetSessionCache(context?: ResolvedComposioContext | null): void {
  if (context) {
    sessionCache.delete(composioContextCacheKey(context));
  } else {
    sessionCache.clear();
  }
  resetComposioInstance();
}
