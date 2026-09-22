import { nextChatSnapshotTimestamp } from '@/app/lib/chat/snapshot-clock';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import { fetchNotebookQuery, notebookQueryKey } from '@/app/lib/queries/client';
import { chatMessageResource, invalidateChatQueries, seedCreatedChatSession } from '@/app/lib/queries/chat-queries';
export { fetchChatSessionBootstrap } from '@/app/lib/queries/chat-queries';
import type {
  AISession,
  ChatHistorySearchResult,
  ChatRequestContext,
  PersistedChatMessage,
} from '@/app/lib/chat/types';
import type {
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

export type ChatSessionMessagesPayload = {
  /** Browser read provenance; always assigned locally, never accepted from the server. */
  clientReadStartedAt?: number;
  success: boolean;
  messages?: PersistedChatMessage[];
  hasMoreBefore?: boolean;
  oldestTimestamp?: number | null;
  oldestMessageId?: number | null;
  oldestSequence?: number | null;
};

export type CreateChatSessionPayload = {
  agentId: string;
  clientRequestId?: string;
  title?: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  runtimeSelection?: AiRuntimeSelection;
  expectedCatalogRevision?: number;
  expectedPolicyRevision?: number;
  workspaceId?: string;
  workspace?: ChatRequestContext['workspace'];
};

export type CreateChatSessionResponse = {
  success: boolean;
  created?: boolean;
  error?: string;
  code?: string;
  currentCatalogRevision?: number;
  currentPolicyRevision?: number;
  session?: Partial<AISession> & {
    sessionId?: string;
    provider?: string | null;
    model?: string;
    thinkingLevel?: PiThinkingLevel | null;
  };
  runtime?: AiSessionRuntimeSnapshot;
  resolution?: AiEffectiveRuntimeResolution;
};

export type UpdateChatSessionRuntimePayload = {
  agentId: string;
  sessionId: string;
  runtimeSelection: AiRuntimeSelection;
  expectedCatalogRevision: number;
  expectedPolicyRevision: number;
};

export type PatchChatSessionsResponse = {
  success: boolean;
  error?: string;
  code?: string;
  lastViewedAt?: string;
  session?: Partial<AISession>;
  runtime?: AiSessionRuntimeSnapshot;
  resolution?: AiEffectiveRuntimeResolution;
};

export type ForkChatSessionPayload = {
  agentId: string;
  workspaceId: string;
  throughSequence: number;
  clientRequestId: string;
};

export type ForkChatSessionResponse = {
  success: boolean;
  created?: boolean;
  copiedMessageCount?: number;
  throughSequence?: number;
  error?: string;
  code?: string;
  session?: Partial<AISession> & {
    id?: number;
    sessionId?: string;
    title?: string | null;
    model?: string;
  };
};

export async function fetchChatSessions(agentId = 'all', options: { workspaceId?: string | null; signal?: AbortSignal } = {}): Promise<AISession[]> {
  const params = new URLSearchParams({ agentId });
  if (options.workspaceId) {
    params.set('workspaceId', options.workspaceId);
  }
  return fetchNotebookQuery({ workspaceId: options.workspaceId ?? null, resource: ['chat', 'sessions', agentId],
    signal: options.signal, staleTime: 15_000, queryFn: async ({ signal }) => {
      const res = await fetch(`/api/sessions?${params.toString()}`, { signal });
      const data = await safeFetchJson<{ success: boolean; sessions?: AISession[] }>(res);
      if (!data?.success || !Array.isArray(data.sessions)) throw new Error('Failed to load chat history.');
      return data.sessions;
    } });
}

export async function searchChatSessions(params: {
  query: string;
  agentId?: string;
  workspaceId?: string | null;
  unreadOnly?: boolean;
  signal?: AbortSignal;
}): Promise<ChatHistorySearchResult[]> {
  const searchParams = new URLSearchParams({
    query: params.query,
    agentId: params.agentId || 'all',
  });
  if (params.workspaceId) {
    searchParams.set('workspaceId', params.workspaceId);
  }
  if (params.unreadOnly) {
    searchParams.set('unreadOnly', 'true');
  }

  return fetchNotebookQuery({
    workspaceId: params.workspaceId ?? null,
    resource: ['chat', 'search', params.agentId || 'all', params.query, params.unreadOnly ?? false],
    signal: params.signal,
    staleTime: 10_000,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/sessions/search?${searchParams.toString()}`, { signal });
      const data = await safeFetchJson<{ success: boolean; results?: ChatHistorySearchResult[] }>(response);
      if (!data?.success || !Array.isArray(data.results)) throw new Error('Failed to search chat history.');
      return data.results;
    },
  });
}

export async function createChatSession(payload: CreateChatSessionPayload): Promise<CreateChatSessionResponse | null> {
  const scope = notebookQueryKey(null)[1];
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await safeFetchJson<CreateChatSessionResponse>(res);
  if (!res.ok || !data?.success || !data.session?.sessionId) {
    return {
      ...(data ?? {}),
      success: false,
      error: data?.error || `Failed to create session (HTTP ${res.status})`,
    };
  }
  void invalidateChatQueries(payload.workspaceId, scope);
  if (data.created && data.session?.sessionId) {
    seedCreatedChatSession(data.session, payload.workspaceId ?? payload.workspace?.workspaceId ?? null, scope);
  }
  return data;
}

export async function forkChatSession(
  sourceSessionId: string,
  payload: ForkChatSessionPayload,
): Promise<ForkChatSessionResponse> {
  const scope = notebookQueryKey(null)[1];
  const response = await fetch(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await safeFetchJson<ForkChatSessionResponse>(response);
  if (!response.ok || !data?.success || !data.session?.sessionId) {
    return {
      ...(data ?? {}),
      success: false,
      error: data?.error || `Failed to fork session (HTTP ${response.status})`,
    };
  }
  void invalidateChatQueries(payload.workspaceId, scope);
  return data;
}

export async function patchChatSessions(
  payload: Record<string, unknown> | UpdateChatSessionRuntimePayload,
): Promise<PatchChatSessionsResponse | null> {
  const scope = notebookQueryKey(null)[1];
  const res = await fetch('/api/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await safeFetchJson<PatchChatSessionsResponse>(res);
  if (data?.success) void invalidateChatQueries('workspaceId' in payload && typeof payload.workspaceId === 'string' ? payload.workspaceId : null, scope);
  return data;
}

export async function deleteChatSession(agentId: string, sessionId: string): Promise<{ success: boolean } | null> {
  const scope = notebookQueryKey(null)[1];
  const params = new URLSearchParams({ agentId, sessionId });
  const res = await fetch(`/api/sessions?${params.toString()}`, { method: 'DELETE' });
  const data = await safeFetchJson<{ success: boolean }>(res);
  if (data?.success) void invalidateChatQueries(null, scope);
  return data;
}

export async function fetchChatSessionMessages(params: {
  agentId: string;
  sessionId: string;
  limit?: number;
  before?: number | null;
  beforeId?: number | null;
  beforeSequence?: number | null;
  workspaceId?: string | null;
  signal?: AbortSignal;
  cache?: RequestCache;
  credentials?: RequestCredentials;
}): Promise<ChatSessionMessagesPayload | null> {
  const searchParams = new URLSearchParams({
    agentId: params.agentId,
    sessionId: params.sessionId,
    limit: String(params.limit ?? 50),
  });

  if (params.beforeSequence !== null && params.beforeSequence !== undefined) {
    searchParams.set('beforeSequence', String(params.beforeSequence));
  } else if (params.before !== null && params.before !== undefined) {
    searchParams.set('before', String(params.before));
  }
  if (params.beforeId !== null && params.beforeId !== undefined) {
    searchParams.set('beforeId', String(params.beforeId));
  }
  if (params.workspaceId) {
    searchParams.set('workspaceId', params.workspaceId);
  }

  return fetchNotebookQuery({ workspaceId: params.workspaceId ?? null, resource: chatMessageResource(params),
    staleTime: params.cache === 'no-store' ? 0 : 10_000, signal: params.signal,
    queryFn: async ({ signal }) => {
      const clientReadStartedAt = nextChatSnapshotTimestamp();
      const response = await fetch(`/api/sessions/messages?${searchParams.toString()}`, {
        signal, cache: 'no-store', credentials: params.credentials ?? 'include',
      });
      const payload = await safeFetchJson<ChatSessionMessagesPayload>(response);
      if (!payload?.success || !Array.isArray(payload.messages)) throw new Error('Failed to load chat messages.');
      return { ...payload, clientReadStartedAt };
    } });
}
