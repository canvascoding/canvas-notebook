import 'server-only';

import { Composio } from '@composio/core';
import { readScopedEnvState, type EnvStorageScope } from '../integrations/env-config';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import { getComposioUserId } from './composio-identity';

const composioInstances = new Map<string, Composio>();

export type ComposioMode = 'local' | 'managed' | 'disabled';

function isManagedComposioAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(getManagedControlPlaneBaseUrl()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

export function isManagedComposioConfigured(): boolean {
  return isManagedComposioAvailable();
}

export async function getLocalComposioApiKey(storageScope?: EnvStorageScope | null): Promise<string | null> {
  const managedAvailable = isManagedComposioAvailable();
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    const envKey = byKey.get('COMPOSIO_API_KEY')?.trim();
    if (envKey) return envKey;

    if (!managedAvailable && (storageScope?.userId?.trim() || storageScope?.organizationId?.trim())) {
      const legacyState = await readScopedEnvState('integrations', { secretScope: 'legacy' });
      const legacyKey = legacyState.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim();
      if (legacyKey) return legacyKey;
    }

    if (!managedAvailable && process.env.COMPOSIO_API_KEY) return process.env.COMPOSIO_API_KEY.trim() || null;
    return null;
  } catch {
    return !managedAvailable ? process.env.COMPOSIO_API_KEY?.trim() || null : null;
  }
}

export async function getComposioMode(storageScope?: EnvStorageScope | null): Promise<ComposioMode> {
  const localKey = await getLocalComposioApiKey(storageScope);
  if (localKey) return 'local';
  if (isManagedComposioAvailable()) return 'managed';
  return 'disabled';
}

export async function getComposio(storageScope?: EnvStorageScope | null): Promise<Composio | null> {
  const apiKey = await getLocalComposioApiKey(storageScope);
  if (!apiKey) return null;

  const cached = composioInstances.get(apiKey);
  if (cached) {
    return cached;
  }

  const composio = new Composio({ apiKey });
  composioInstances.set(apiKey, composio);
  return composio;
}

export async function verifyApiKey(storageScope?: EnvStorageScope | null): Promise<boolean> {
  try {
    const composio = await getComposio(storageScope);
    if (!composio) return false;
    await composio.connectedAccounts.list({ userIds: [await getComposioUserId(storageScope)], limit: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function isComposioConfigured(storageScope?: EnvStorageScope | null): Promise<boolean> {
  return (await getComposioMode(storageScope)) !== 'disabled';
}

export function resetComposioInstance(): void {
  composioInstances.clear();
}
