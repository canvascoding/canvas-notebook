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
  progressRevision?: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatDelegationProgressEvent = {
  revision: number;
  kind: 'queued' | 'running' | 'tool_start' | 'tool_end' | 'compacting' | 'resumed' | 'completed' | 'failed' | 'cancelled';
  preview: string | null;
  createdAt: string;
};

export type ChatDelegationProgress = {
  delegation: {
    id: string;
    workerSessionId: string;
    status: ChatDelegation['status'];
    displayStatus: ChatDelegation['status'] | 'interrupted' | 'unknown';
    leaseState: 'active' | 'expired' | 'unknown' | null;
    revision: number;
  };
  events: ChatDelegationProgressEvent[];
  transcript: Array<{ sequence: number; timestamp: number; role: string; text: null; toolNames: string[]; isError: boolean }>;
};

export type ChatDelegationTranscriptMessage = {
  id: number;
  sequence: number;
  role: string;
  content: unknown;
  toolName?: string;
  createdAt: string;
};

export type ChatDelegationTranscriptPage = {
  messages: ChatDelegationTranscriptMessage[];
  hasMoreBefore: boolean;
  oldestSequence: number | null;
  oldestMessageId: number | null;
};

export type ChatDelegationSteeringReceipt = {
  id: string;
  delegationId: string;
  status: 'accepted' | 'delivered' | 'missed';
  createdAt: string;
  deliveredAt: string | null;
  missedAt: string | null;
};

export async function fetchChatDelegationProgress(input: {
  id: string;
  sourceSessionId: string;
  afterRevision?: number;
  tailLimit?: number;
  signal?: AbortSignal;
}): Promise<ChatDelegationProgress> {
  const query = new URLSearchParams({
    sourceSessionId: input.sourceSessionId,
    afterRevision: String(input.afterRevision ?? 0),
    limit: '100',
    tailLimit: String(input.tailLimit ?? 0),
  });
  const response = await fetch(`/api/delegations/${encodeURIComponent(input.id)}/progress?${query.toString()}`, {
    cache: 'no-store',
    signal: input.signal,
  });
  const payload = await safeFetchJson<ChatDelegationProgress & { success: boolean; error?: string }>(response);
  if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Failed to load delegation progress.');
  return payload;
}

export async function fetchChatDelegationTranscript(input: {
  id: string;
  workerSessionId: string;
  agentId: string;
  sourceSessionId: string;
  beforeSequence?: number;
  beforeId?: number;
  signal?: AbortSignal;
}): Promise<ChatDelegationTranscriptPage> {
  const query = new URLSearchParams({
    sessionId: input.workerSessionId,
    agentId: input.agentId,
    sourceSessionId: input.sourceSessionId,
    delegationId: input.id,
    limit: '50',
  });
  if (input.beforeSequence !== undefined) query.set('beforeSequence', String(input.beforeSequence));
  if (input.beforeId !== undefined) query.set('beforeId', String(input.beforeId));
  const response = await fetch(`/api/sessions/messages?${query.toString()}`, { cache: 'no-store', signal: input.signal });
  const payload = await safeFetchJson<ChatDelegationTranscriptPage & { success: boolean; error?: string }>(response);
  if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Failed to load worker transcript.');
  return payload;
}

export async function sendChatDelegationSteering(input: {
  id: string;
  sourceSessionId: string;
  message: string;
  requestId: string;
}): Promise<ChatDelegationSteeringReceipt> {
  const response = await fetch(`/api/delegations/${encodeURIComponent(input.id)}/steering`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceSessionId: input.sourceSessionId, message: input.message, requestId: input.requestId }),
  });
  const payload = await safeFetchJson<{ success: boolean; receipt?: ChatDelegationSteeringReceipt; error?: string }>(response);
  if (!response.ok || !payload?.success || !payload.receipt) throw new Error(payload?.error || 'Failed to send steering.');
  return payload.receipt;
}

export async function fetchChatDelegationSteeringReceipt(input: {
  id: string;
  sourceSessionId: string;
  receiptId: string;
  signal?: AbortSignal;
}): Promise<ChatDelegationSteeringReceipt> {
  const query = new URLSearchParams({ sourceSessionId: input.sourceSessionId, receiptId: input.receiptId });
  const response = await fetch(`/api/delegations/${encodeURIComponent(input.id)}/steering?${query.toString()}`, {
    cache: 'no-store', signal: input.signal,
  });
  const payload = await safeFetchJson<{ success: boolean; receipt?: ChatDelegationSteeringReceipt; error?: string }>(response);
  if (!response.ok || !payload?.success || !payload.receipt) throw new Error(payload?.error || 'Failed to load steering receipt.');
  return payload.receipt;
}

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
  sessionId?: string;
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

export async function cancelChatDelegation(id: string, sourceSessionId: string): Promise<{
  id: string;
  status: ChatDelegation['status'];
  cancelRequestedAt: string | null;
  completedAt: string | null;
}> {
  const query = new URLSearchParams({ sourceSessionId });
  const response = await fetch(`/api/delegations/${encodeURIComponent(id)}?${query.toString()}`, {
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
