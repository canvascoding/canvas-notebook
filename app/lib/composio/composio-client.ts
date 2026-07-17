import 'server-only';

import { Composio } from '@composio/core';
import { readScopedEnvState, type EnvStorageScope } from '../integrations/env-config';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import type { ResolvedComposioContext } from './composio-context';

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
    const centralState = await readScopedEnvState('integrations', { secretScope: 'legacy' });
    const centralKey = centralState.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim();
    if (centralKey) return centralKey;

    // Transitional fallback for installations that stored the project key in a
    // user-scoped env file before Composio profiles existed. New UI writes the
    // single project key to the system/legacy integration store.
    if (storageScope?.userId?.trim() || storageScope?.organizationId?.trim()) {
      const scopedState = await readScopedEnvState('integrations', storageScope);
      const scopedKey = scopedState.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim();
      if (scopedKey) return scopedKey;
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

export async function verifyApiKey(context: ResolvedComposioContext): Promise<boolean> {
  try {
    const composio = await getComposio(context.storageScope);
    if (!composio) return false;
    await composio.connectedAccounts.list({ userIds: [context.composioUserId], limit: 1 });
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
