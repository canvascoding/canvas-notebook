import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AISession, PersistedChatMessage } from '@/app/lib/chat/types';
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
};

export type CreateChatSessionResponse = {
  success: boolean;
  error?: string;
  session?: Partial<AISession> & {
    sessionId?: string;
    provider?: string | null;
    model?: string;
    thinkingLevel?: PiThinkingLevel | null;
  };
};

export async function fetchChatSessions(agentId = 'all'): Promise<AISession[]> {
  const params = new URLSearchParams({ agentId });
  const res = await fetch(`/api/sessions?${params.toString()}`);
  const data = await safeFetchJson<{ success: boolean; sessions?: AISession[] }>(res);
  return data?.success ? data.sessions || [] : [];
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
      success: false,
      error: data?.error || `Failed to create session (HTTP ${res.status})`,
      session: data?.session,
    };
  }
  return data;
}

export async function patchChatSessions(payload: Record<string, unknown>): Promise<{ success: boolean; lastViewedAt?: string } | null> {
  const res = await fetch('/api/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return safeFetchJson<{ success: boolean; lastViewedAt?: string }>(res);
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

  const response = await fetch(`/api/sessions/messages?${searchParams.toString()}`, {
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.cache ? { cache: params.cache } : {}),
    ...(params.credentials ? { credentials: params.credentials } : {}),
  });
  return safeFetchJson<ChatSessionMessagesPayload>(response);
}
