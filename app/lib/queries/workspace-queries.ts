import type { AiEffectiveRuntimeResolution } from '@/app/lib/agent-runtime-policy/types';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AgentProfile } from '@/app/lib/chat/types';
import { fetchNotebookQuery, notebookQueryKey } from '@/app/lib/queries/client';

export type UserPreferencesResponse = {
  success: boolean;
  data?: { lastActiveAgentId?: string };
};

type EffectiveRuntimeResponse = {
  success?: boolean;
  resolution?: AiEffectiveRuntimeResolution;
  data?: AiEffectiveRuntimeResolution;
  error?: string;
};

export type RuntimeQueryContext = {
  workspaceId: string;
  agentId: string;
  sessionId: string | null;
};

export const workspaceQueryKeys = {
  agents: (workspaceId: string) => notebookQueryKey(workspaceId, 'agents'),
  preferences: () => notebookQueryKey(null, 'user-preferences'),
  runtime: ({ workspaceId, agentId, sessionId }: RuntimeQueryContext) => (
    notebookQueryKey(workspaceId, 'effective-runtime', agentId, sessionId)
  ),
};

export function fetchWorkspaceAgents(workspaceId: string): Promise<AgentProfile[]> {
  return fetchNotebookQuery({
    workspaceId,
    resource: ['agents'],
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ workspaceId });
      const response = await fetch(`/api/agents?${query.toString()}`, { cache: 'no-store', signal });
      const payload = await safeFetchJson<{ success: boolean; data?: { agents?: AgentProfile[] } }>(response);
      if (!payload?.success || !Array.isArray(payload.data?.agents)) {
        throw new Error('Failed to load chat agents.');
      }
      return payload.data.agents;
    },
  });
}

export function fetchWorkspaceUserPreferences(): Promise<UserPreferencesResponse> {
  return fetchNotebookQuery({
    workspaceId: null,
    resource: ['user-preferences'],
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/user-preferences', {
        cache: 'no-store', credentials: 'include', signal,
      });
      const payload = await safeFetchJson<UserPreferencesResponse>(response);
      if (!response.ok || !payload?.success) {
        throw new Error('Failed to load user preferences.');
      }
      return payload;
    },
  });
}

export function isRuntimeResolution(value: unknown): value is AiEffectiveRuntimeResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AiEffectiveRuntimeResolution>;
  return Number.isSafeInteger(candidate.catalogRevision)
    && Number.isSafeInteger(candidate.policyRevision)
    && Array.isArray(candidate.providers)
    && Array.isArray(candidate.issues);
}

export function fetchEffectiveRuntime(
  context: RuntimeQueryContext,
  signal?: AbortSignal,
): Promise<AiEffectiveRuntimeResolution> {
  return fetchNotebookQuery({
    workspaceId: context.workspaceId,
    resource: ['effective-runtime', context.agentId, context.sessionId],
    staleTime: 15_000,
    signal,
    queryFn: async ({ signal: querySignal }) => {
      const query = new URLSearchParams({ workspaceId: context.workspaceId, agentId: context.agentId });
      if (context.sessionId) query.set('sessionId', context.sessionId);
      const response = await fetch(`/api/agent-runtime/effective?${query.toString()}`, {
        cache: 'no-store', signal: querySignal,
      });
      const payload = await response.json().catch(() => null) as EffectiveRuntimeResponse | null;
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || `Runtime selection could not be loaded (HTTP ${response.status}).`);
      }
      const resolution = payload.resolution ?? payload.data;
      if (!isRuntimeResolution(resolution)) {
        throw new Error('The runtime service returned an invalid response.');
      }
      return resolution;
    },
  });
}
