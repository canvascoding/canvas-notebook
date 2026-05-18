import 'server-only';

import { Composio } from '@composio/core';
import { readScopedEnvState } from '../integrations/env-config';
import { getComposioUserId } from './composio-identity';

let composioInstance: Composio | null = null;

export type ComposioMode = 'local' | 'managed' | 'disabled';

function isManagedComposioAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(process.env.CANVAS_CONTROL_PLANE_URL?.trim()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

export async function getLocalComposioApiKey(): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations');
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    const envKey = byKey.get('COMPOSIO_API_KEY');
    if (envKey) return envKey;
    if (!isManagedComposioAvailable() && process.env.COMPOSIO_API_KEY) return process.env.COMPOSIO_API_KEY;
    return null;
  } catch {
    return !isManagedComposioAvailable() ? process.env.COMPOSIO_API_KEY || null : null;
  }
}

export async function getComposioMode(): Promise<ComposioMode> {
  const localKey = await getLocalComposioApiKey();
  if (localKey) return 'local';
  if (isManagedComposioAvailable()) return 'managed';
  return 'disabled';
}

let cachedApiKey: string | null = null;

export async function getComposio(): Promise<Composio | null> {
  const apiKey = await getLocalComposioApiKey();
  if (!apiKey) return null;

  if (composioInstance && cachedApiKey === apiKey) {
    return composioInstance;
  }

  composioInstance = new Composio({ apiKey });
  cachedApiKey = apiKey;
  return composioInstance;
}

export async function verifyApiKey(): Promise<boolean> {
  try {
    const composio = await getComposio();
    if (!composio) return false;
    await composio.connectedAccounts.list({ userIds: [await getComposioUserId()], limit: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function isComposioConfigured(): Promise<boolean> {
  return (await getComposioMode()) !== 'disabled';
}

export function resetComposioInstance(): void {
  composioInstance = null;
  cachedApiKey = null;
}
