import { safeFetchJson } from '@/app/lib/chat/fetch-json';
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
  success: boolean;
  messages?: PersistedChatMessage[];
  hasMoreBefore?: boolean;
  oldestTimestamp?: number | null;
  oldestMessageId?: number | null;
  oldestSequence?: number | null;
};

export type CreateChatSessionPayload = {
  agentId: string;
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

export async function fetchChatSessions(agentId = 'all', options: { workspaceId?: string | null } = {}): Promise<AISession[]> {
  const params = new URLSearchParams({ agentId });
  if (options.workspaceId) {
    params.set('workspaceId', options.workspaceId);
  }
  const res = await fetch(`/api/sessions?${params.toString()}`);
  const data = await safeFetchJson<{ success: boolean; sessions?: AISession[] }>(res);
  return data?.success ? data.sessions || [] : [];
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

  const response = await fetch(`/api/sessions/search?${searchParams.toString()}`, {
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const data = await safeFetchJson<{ success: boolean; results?: ChatHistorySearchResult[] }>(response);
  return data?.success ? data.results || [] : [];
}

export async function createChatSession(payload: CreateChatSessionPayload): Promise<CreateChatSessionResponse | null> {
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
  return data;
}

export async function patchChatSessions(
  payload: Record<string, unknown> | UpdateChatSessionRuntimePayload,
): Promise<PatchChatSessionsResponse | null> {
  const res = await fetch('/api/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return safeFetchJson<PatchChatSessionsResponse>(res);
}

export async function deleteChatSession(agentId: string, sessionId: string): Promise<{ success: boolean } | null> {
  const params = new URLSearchParams({ agentId, sessionId });
  const res = await fetch(`/api/sessions?${params.toString()}`, { method: 'DELETE' });
  return safeFetchJson<{ success: boolean }>(res);
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

  const response = await fetch(`/api/sessions/messages?${searchParams.toString()}`, {
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.cache ? { cache: params.cache } : {}),
    ...(params.credentials ? { credentials: params.credentials } : {}),
  });
  return safeFetchJson<ChatSessionMessagesPayload>(response);
}
