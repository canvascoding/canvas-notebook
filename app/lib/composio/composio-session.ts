import 'server-only';

import { getComposio, resetComposioInstance } from './composio-client';
import { getComposioUserId, resetComposioUserIdCache } from './composio-identity';
import type { EnvStorageScope } from '../integrations/env-config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionCache = new Map<string, any>();

function storageScopeCacheKey(storageScope?: EnvStorageScope | null): string {
  const userId = storageScope?.userId?.trim() || '';
  const organizationId = storageScope?.organizationId?.trim() || '';
  const secretScope = storageScope?.secretScope || (userId ? 'user' : organizationId ? 'organization' : 'legacy');
  return `${secretScope}:${userId}:${organizationId}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioSession(storageScope?: EnvStorageScope | null): Promise<any | null> {
  const composio = await getComposio(storageScope);
  if (!composio) return null;
  const userId = await getComposioUserId(storageScope);
  const cacheKey = `${storageScopeCacheKey(storageScope)}:${userId}`;

  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey)!;
  }

  try {
    const session = await composio.create(userId);
    sessionCache.set(cacheKey, session);
    return session;
  } catch (error) {
    console.error('[Composio] Failed to create session:', error);
    return null;
  }
}

export function resetSessionCache(): void {
  sessionCache.clear();
  resetComposioUserIdCache();
  resetComposioInstance();
}

export { getComposioUserId };
