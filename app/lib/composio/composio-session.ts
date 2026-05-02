import 'server-only';

import { getComposio, resetComposioInstance } from './composio-client';

const COMPOSIO_USER_ID = 'local-user';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionCache = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioSession(): Promise<any | null> {
  const composio = await getComposio();
  if (!composio) return null;

  if (sessionCache.has(COMPOSIO_USER_ID)) {
    return sessionCache.get(COMPOSIO_USER_ID)!;
  }

  try {
    const session = await composio.create(COMPOSIO_USER_ID);
    sessionCache.set(COMPOSIO_USER_ID, session);
    return session;
  } catch (error) {
    console.error('[Composio] Failed to create session:', error);
    return null;
  }
}

export function resetSessionCache(): void {
  sessionCache.clear();
  resetComposioInstance();
}

export function getComposioUserId(): string {
  return COMPOSIO_USER_ID;
}