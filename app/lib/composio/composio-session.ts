import 'server-only';

import { getComposio, resetComposioInstance } from './composio-client';
import { getComposioUserId, resetComposioUserIdCache } from './composio-identity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionCache = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioSession(): Promise<any | null> {
  const composio = await getComposio();
  if (!composio) return null;
  const userId = await getComposioUserId();

  if (sessionCache.has(userId)) {
    return sessionCache.get(userId)!;
  }

  try {
    const session = await composio.create(userId);
    sessionCache.set(userId, session);
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
