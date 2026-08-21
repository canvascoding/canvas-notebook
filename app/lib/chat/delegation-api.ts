import { safeFetchJson } from '@/app/lib/chat/fetch-json';

export type ChatDelegation = {
  id: string;
  sourceSessionId: string;
  sourceAgentId: string;
  workerSessionId: string;
  targetAgentId: string | null;
  workerType: 'ephemeral' | 'managed';
  goal: string;
  workerRole: string | null;
  toolsets: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultStatus: 'ok' | 'timeout' | 'error' | null;
  resultText: string | null;
  errorText: string | null;
  deliveryStatus: 'pending' | 'delivering' | 'delivered' | 'failed' | 'skipped';
  deliveryErrorText: string | null;
  attemptCount: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DelegationOptions = {
  agents: Array<{ agentId: string; name: string; iconId: string | null }>;
  toolsets: Array<{ name: string; label: string; description: string }>;
};

export async function fetchDelegationOptions(sourceSessionId: string): Promise<DelegationOptions> {
  const query = new URLSearchParams({ sourceSessionId, options: 'true' });
  const response = await fetch(`/api/delegations?${query.toString()}`, { cache: 'no-store' });
  const payload = await safeFetchJson<{ success: boolean; agents?: DelegationOptions['agents']; toolsets?: DelegationOptions['toolsets']; error?: string }>(response);
  if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Failed to load delegation options.');
  return { agents: payload.agents || [], toolsets: payload.toolsets || [] };
}

export async function startChatDelegation(input: {
  sourceSessionId: string;
  targetAgentId: string;
  goal: string;
  context?: string;
  toolsets: string[];
}): Promise<void> {
  const response = await fetch('/api/delegations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeFetchJson<{ success: boolean; error?: string }>(response);
  if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Failed to start delegation.');
}

export async function fetchChatDelegations(
  sourceSessionId: string,
  signal?: AbortSignal,
): Promise<ChatDelegation[]> {
  const query = new URLSearchParams({ sourceSessionId });
  const response = await fetch(`/api/delegations?${query.toString()}`, {
    cache: 'no-store',
    signal,
  });
  const payload = await safeFetchJson<{ success: boolean; delegations?: ChatDelegation[] }>(response);
  if (!response.ok || !payload?.success) {
    throw new Error(`Failed to load delegated tasks (HTTP ${response.status}).`);
  }
  return payload.delegations ?? [];
}

export async function cancelChatDelegation(id: string): Promise<{
  id: string;
  status: ChatDelegation['status'];
  cancelRequestedAt: string | null;
  completedAt: string | null;
}> {
  const response = await fetch(`/api/delegations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const payload = await safeFetchJson<{
    success: boolean;
    error?: string;
    delegation?: {
      id: string;
      status: ChatDelegation['status'];
      cancelRequestedAt: string | null;
      completedAt: string | null;
    };
  }>(response);
  if (!response.ok || !payload?.success || !payload.delegation) {
    throw new Error(payload?.error || `Failed to cancel delegated task (HTTP ${response.status}).`);
  }
  return payload.delegation;
}
