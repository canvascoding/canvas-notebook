import 'server-only';

import crypto from 'crypto';

import { mutateScopedEnvEntries, readScopedEnvState, type EnvStorageScope } from '../integrations/env-config';
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

async function persistComposioUserId(
  value: string,
  storageScope?: EnvStorageScope | null,
  preserveExisting = false,
): Promise<string> {
  let persisted = value;
  const state = await mutateScopedEnvEntries('integrations', (entries) => {
    const existing = entries.find((entry) => entry.key === COMPOSIO_USER_ID_KEY)?.value.trim();
    if (preserveExisting && existing) {
      persisted = existing;
      return entries;
    }
    persisted = value;
    return existing
      ? entries.map((entry) => entry.key === COMPOSIO_USER_ID_KEY ? { key: COMPOSIO_USER_ID_KEY, value } : entry)
      : [...entries, { key: COMPOSIO_USER_ID_KEY, value }];
  }, storageScope);
  return state.entries.find((entry) => entry.key === COMPOSIO_USER_ID_KEY)?.value.trim() || persisted;
}

export async function getComposioUserId(storageScope?: EnvStorageScope | null): Promise<string> {
  const cacheKey = scopeCacheKey(storageScope);
  const cachedUserId = cachedUserIds.get(cacheKey);
  if (cachedUserId) return cachedUserId;

  const state = await readScopedEnvState('integrations', storageScope);
  const envValue = state.entries.find((entry) => entry.key === COMPOSIO_USER_ID_KEY)?.value.trim();
  const hasLocalComposioKey = Boolean(state.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim());
  const managedUserId = !hasLocalComposioKey && isManagedInstance() ? composioUserIdFromInstance(storageScope) : null;
  if (managedUserId && envValue !== managedUserId) {
    const persisted = await persistComposioUserId(managedUserId, storageScope);
    cachedUserIds.set(cacheKey, persisted);
    return persisted;
  }
  if (envValue) {
    cachedUserIds.set(cacheKey, envValue);
    return envValue;
  }

  const generatedManagedUserId = isManagedInstance() ? composioUserIdFromInstance(storageScope) : null;
  if (generatedManagedUserId) {
    const persisted = await persistComposioUserId(generatedManagedUserId, storageScope);
    cachedUserIds.set(cacheKey, persisted);
    return persisted;
  }

  const processValue = process.env.COMPOSIO_USER_ID?.trim();
  if (processValue && !storageScope?.userId?.trim() && !storageScope?.organizationId?.trim()) {
    cachedUserIds.set(cacheKey, processValue);
    return processValue;
  }

  const generated = composioUserIdFromInstance(storageScope) || `${COMPOSIO_USER_ID_PREFIX}${crypto.randomUUID()}`;
  const userId = await persistComposioUserId(generated, storageScope, true);
  cachedUserIds.set(cacheKey, userId);
  return userId;
}

export function resetComposioUserIdCache(): void {
  cachedUserIds.clear();
}
