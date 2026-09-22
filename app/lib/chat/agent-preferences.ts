import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { normalizeMainAgentIdAlias } from '@/app/lib/agents/main-agent';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import { getNotebookQueryClient } from '@/app/lib/queries/client';
import { fetchWorkspaceUserPreferences, workspaceQueryKeys, type UserPreferencesResponse } from '@/app/lib/queries/workspace-queries';

const MANAGED_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function normalizeStoredAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return MANAGED_AGENT_ID_PATTERN.test(normalized) ? normalizeMainAgentIdAlias(normalized) : null;
}

export async function fetchLastActiveAgentId(): Promise<string> {
  try {
    const payload = await fetchWorkspaceUserPreferences();
    return normalizeStoredAgentId(payload?.data?.lastActiveAgentId) || DEFAULT_AGENT_ID;
  } catch (error) {
    console.error('Failed to load last active agent preference', error);
    return DEFAULT_AGENT_ID;
  }
}

export async function saveLastActiveAgentId(agentId: string): Promise<void> {
  const normalizedAgentId = normalizeStoredAgentId(agentId);
  if (!normalizedAgentId) return;

  // Capture the authenticated cache scope before the asynchronous mutation.
  const queryClient = getNotebookQueryClient();
  const queryKey = workspaceQueryKeys.preferences();

  try {
    const response = await fetch('/api/user-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ lastActiveAgentId: normalizedAgentId }),
    });
    const payload = await safeFetchJson<UserPreferencesResponse>(response);
    if (response.ok && payload?.success) {
      // Invalidate instead of seeding from this response: concurrent preference
      // writes may complete in a different order from their server commits.
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true });
    }
  } catch (error) {
    console.error('Failed to save last active agent preference', error);
  }
}
