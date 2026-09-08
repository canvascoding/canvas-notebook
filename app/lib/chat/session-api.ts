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

export async function forkChatSession(
  sourceSessionId: string,
  payload: ForkChatSessionPayload,
): Promise<ForkChatSessionResponse> {
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
  exportProjection?: boolean;
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
  if (params.exportProjection) {
    searchParams.set('export', 'true');
  }

  const response = await fetch(`/api/sessions/messages?${searchParams.toString()}`, {
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.cache ? { cache: params.cache } : {}),
    ...(params.credentials ? { credentials: params.credentials } : {}),
  });
  return safeFetchJson<ChatSessionMessagesPayload>(response);
}

export async function fetchCompleteChatSessionExport(params: {
  agentId: string;
  sessionId: string;
  workspaceId?: string | null;
  signal?: AbortSignal;
}): Promise<PersistedChatMessage[]> {
  const messages: PersistedChatMessage[] = [];
  let before: number | null = null;
  let beforeId: number | null = null;
  let beforeSequence: number | null = null;
  let hasMoreBefore = true;
  let previousCursor = '';

  while (hasMoreBefore) {
    const payload = await fetchChatSessionMessages({
      ...params,
      before,
      beforeId,
      beforeSequence,
      cache: 'no-store',
      credentials: 'include',
      exportProjection: true,
      limit: 200,
    });

    if (!payload?.success || !Array.isArray(payload.messages)) {
      throw new Error('Failed to load complete chat export.');
    }

    messages.unshift(...payload.messages);
    hasMoreBefore = payload.hasMoreBefore === true;
    if (!hasMoreBefore) {
      break;
    }

    beforeSequence = payload.oldestSequence ?? null;
    before = beforeSequence === null ? payload.oldestTimestamp ?? null : null;
    beforeId = payload.oldestMessageId ?? null;
    const cursor = `${beforeSequence ?? ''}:${before ?? ''}:${beforeId ?? ''}`;
    if ((beforeSequence === null && before === null) || cursor === previousCursor) {
      throw new Error('Chat export pagination did not advance.');
    }
    previousCursor = cursor;
  }

  return messages;
}
