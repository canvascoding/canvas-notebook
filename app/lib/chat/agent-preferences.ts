import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';

type UserPreferencesResponse = {
  success: boolean;
  data?: {
    lastActiveAgentId?: string;
  };
};

const MANAGED_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function normalizeStoredAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return MANAGED_AGENT_ID_PATTERN.test(normalized) ? normalized : null;
}

export async function fetchLastActiveAgentId(): Promise<string> {
  try {
    const response = await fetch('/api/user-preferences', {
      cache: 'no-store',
      credentials: 'include',
    });
    const payload = await safeFetchJson<UserPreferencesResponse>(response);
    return normalizeStoredAgentId(payload?.data?.lastActiveAgentId) || DEFAULT_AGENT_ID;
  } catch (error) {
    console.error('Failed to load last active agent preference', error);
    return DEFAULT_AGENT_ID;
  }
}

export async function saveLastActiveAgentId(agentId: string): Promise<void> {
  const normalizedAgentId = normalizeStoredAgentId(agentId);
  if (!normalizedAgentId) return;

  try {
    await fetch('/api/user-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ lastActiveAgentId: normalizedAgentId }),
    });
  } catch (error) {
    console.error('Failed to save last active agent preference', error);
  }
}
