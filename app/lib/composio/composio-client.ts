import 'server-only';

import { Composio } from '@composio/core';
import { readScopedEnvState } from '../integrations/env-config';

let composioInstance: Composio | null = null;

async function getComposioApiKey(): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations');
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    const envKey = byKey.get('COMPOSIO_API_KEY');
    if (envKey) return envKey;
    if (process.env.COMPOSIO_API_KEY) return process.env.COMPOSIO_API_KEY;
    return null;
  } catch {
    return process.env.COMPOSIO_API_KEY || null;
  }
}

let cachedApiKey: string | null = null;

export async function getComposio(): Promise<Composio | null> {
  const apiKey = await getComposioApiKey();
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
    await composio.connectedAccounts.list({ userIds: ['local-user'] });
    return true;
  } catch {
    return false;
  }
}

export async function isComposioConfigured(): Promise<boolean> {
  const apiKey = await getComposioApiKey();
  return !!apiKey;
}

export function resetComposioInstance(): void {
  composioInstance = null;
  cachedApiKey = null;
}