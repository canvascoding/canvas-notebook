import 'server-only';

import crypto from 'crypto';

import { readScopedEnvState, replaceScopedEnvEntries } from '../integrations/env-config';

const COMPOSIO_USER_ID_KEY = 'COMPOSIO_USER_ID';
const COMPOSIO_USER_ID_PREFIX = 'canvas-notebook-';

let cachedUserId: string | null = null;

function composioUserIdFromInstance(): string | null {
  const instanceId = process.env.CANVAS_INSTANCE_ID?.trim();
  if (!instanceId) return null;
  return `${COMPOSIO_USER_ID_PREFIX}${instanceId}`;
}

function isManagedInstance(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(process.env.CANVAS_CONTROL_PLANE_URL?.trim()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

async function persistComposioUserId(value: string): Promise<void> {
  const state = await readScopedEnvState('integrations');
  const entries = state.entries
    .filter((entry) => entry.key !== COMPOSIO_USER_ID_KEY)
    .map((entry) => ({ key: entry.key, value: entry.value }));
  entries.push({ key: COMPOSIO_USER_ID_KEY, value });
  await replaceScopedEnvEntries('integrations', entries);
}

export async function getComposioUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  try {
    const state = await readScopedEnvState('integrations');
    const envValue = state.entries.find((entry) => entry.key === COMPOSIO_USER_ID_KEY)?.value.trim();
    const hasLocalComposioKey = Boolean(state.entries.find((entry) => entry.key === 'COMPOSIO_API_KEY')?.value.trim());
    const managedUserId = !hasLocalComposioKey && isManagedInstance() ? composioUserIdFromInstance() : null;
    if (managedUserId && envValue !== managedUserId) {
      try {
        await persistComposioUserId(managedUserId);
      } catch (error) {
        console.warn('[Composio] Failed to persist managed COMPOSIO_USER_ID:', error);
      }
      cachedUserId = managedUserId;
      return managedUserId;
    }
    if (envValue) {
      cachedUserId = envValue;
      return envValue;
    }
  } catch {
  }

  const managedUserId = isManagedInstance() ? composioUserIdFromInstance() : null;
  if (managedUserId) {
    try {
      await persistComposioUserId(managedUserId);
    } catch (error) {
      console.warn('[Composio] Failed to persist managed COMPOSIO_USER_ID:', error);
    }
    cachedUserId = managedUserId;
    return managedUserId;
  }

  const processValue = process.env.COMPOSIO_USER_ID?.trim();
  if (processValue) {
    cachedUserId = processValue;
    return processValue;
  }

  const generated = composioUserIdFromInstance() || `${COMPOSIO_USER_ID_PREFIX}${crypto.randomUUID()}`;
  try {
    await persistComposioUserId(generated);
  } catch (error) {
    console.warn('[Composio] Failed to persist COMPOSIO_USER_ID:', error);
  }
  cachedUserId = generated || 'local-user';
  return cachedUserId;
}

export function resetComposioUserIdCache(): void {
  cachedUserId = null;
}
