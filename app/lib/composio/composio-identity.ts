import 'server-only';

import crypto from 'crypto';

import { readScopedEnvState, replaceScopedEnvEntries, type EnvStorageScope } from '../integrations/env-config';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';

const COMPOSIO_USER_ID_KEY = 'COMPOSIO_USER_ID';
const COMPOSIO_USER_ID_PREFIX = 'canvas-notebook-';

const cachedUserIds = new Map<string, string>();

function scopeCacheKey(storageScope?: EnvStorageScope | null): string {
  const userId = storageScope?.userId?.trim() || '';
  const organizationId = storageScope?.organizationId?.trim() || '';
  const secretScope = storageScope?.secretScope || (userId ? 'user' : organizationId ? 'organization' : 'legacy');
  return `${secretScope}:${userId}:${organizationId}`;
}

function stableScopeSuffix(storageScope?: EnvStorageScope | null): string {
  const userId = storageScope?.userId?.trim();
  if (userId) return `user-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
  const organizationId = storageScope?.organizationId?.trim();
  if (organizationId) return `org-${crypto.createHash('sha256').update(organizationId).digest('hex').slice(0, 16)}`;
  return '';
}

function composioUserIdFromInstance(storageScope?: EnvStorageScope | null): string | null {
  const instanceId = process.env.CANVAS_INSTANCE_ID?.trim();
  if (!instanceId) return null;
  const suffix = stableScopeSuffix(storageScope);
  return suffix ? `${COMPOSIO_USER_ID_PREFIX}${instanceId}-${suffix}` : `${COMPOSIO_USER_ID_PREFIX}${instanceId}`;
}

function isManagedInstance(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(getManagedControlPlaneBaseUrl()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

async function persistComposioUserId(value: string, storageScope?: EnvStorageScope | null): Promise<void> {
  const state = await readScopedEnvState('integrations', storageScope);
  const entries = state.entries
    .filter((entry) => entry.key !== COMPOSIO_USER_ID_KEY)
    .map((entry) => ({ key: entry.key, value: entry.value }));
  entries.push({ key: COMPOSIO_USER_ID_KEY, value });
  await replaceScopedEnvEntries('integrations', entries, storageScope);
}

export async function getComposioUserId(storageScope?: EnvStorageScope | null): Promise<string> {
  const cacheKey = scopeCacheKey(storageScope);
  const cachedUserId = cachedUserIds.get(cacheKey);
  if (cachedUserId) return cachedUserId;

  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const envValue = state.entries.find((entry) => entry.key === COMPOSIO_USER_ID_KEY)?.value.trim();
    const hasLocalComposioKey = Boolean(state.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim());
    const managedUserId = !hasLocalComposioKey && isManagedInstance() ? composioUserIdFromInstance(storageScope) : null;
    if (managedUserId && envValue !== managedUserId) {
      try {
        await persistComposioUserId(managedUserId, storageScope);
      } catch (error) {
        console.warn('[Composio] Failed to persist managed COMPOSIO_USER_ID:', error);
      }
      cachedUserIds.set(cacheKey, managedUserId);
      return managedUserId;
    }
    if (envValue) {
      cachedUserIds.set(cacheKey, envValue);
      return envValue;
    }
  } catch {
  }

  const managedUserId = isManagedInstance() ? composioUserIdFromInstance(storageScope) : null;
  if (managedUserId) {
    try {
      await persistComposioUserId(managedUserId, storageScope);
    } catch (error) {
      console.warn('[Composio] Failed to persist managed COMPOSIO_USER_ID:', error);
    }
    cachedUserIds.set(cacheKey, managedUserId);
    return managedUserId;
  }

  const processValue = process.env.COMPOSIO_USER_ID?.trim();
  if (processValue && !storageScope?.userId?.trim() && !storageScope?.organizationId?.trim()) {
    cachedUserIds.set(cacheKey, processValue);
    return processValue;
  }

  const generated = composioUserIdFromInstance(storageScope) || `${COMPOSIO_USER_ID_PREFIX}${crypto.randomUUID()}`;
  try {
    await persistComposioUserId(generated, storageScope);
  } catch (error) {
    console.warn('[Composio] Failed to persist COMPOSIO_USER_ID:', error);
  }
  const userId = generated || 'local-user';
  cachedUserIds.set(cacheKey, userId);
  return userId;
}

export function resetComposioUserIdCache(): void {
  cachedUserIds.clear();
}
