import { nextChatSnapshotTimestamp } from '@/app/lib/chat/snapshot-clock';
import type { AISession } from '@/app/lib/chat/types';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type { ChatSessionMessagesPayload } from '@/app/lib/chat/session-api';
import { fetchNotebookQuery, getNotebookQueryClient, notebookQueryKey } from './client';

export type ChatMessageQuery = {
  workspaceId?: string | null; agentId: string; sessionId: string; limit?: number;
  before?: number | null; beforeId?: number | null; beforeSequence?: number | null;
};

export function chatMessageResource(input: ChatMessageQuery) {
  return ['chat', 'messages', input.agentId, input.sessionId, input.limit ?? 50,
    input.beforeSequence ?? null, input.beforeSequence == null ? input.before ?? null : null,
    input.beforeId ?? null] as const;
}

export function invalidateChatQueries(workspaceId?: string | null, scope = notebookQueryKey(null)[1]) {
  return getNotebookQueryClient().invalidateQueries({ predicate: ({ queryKey }) => (
    queryKey[0] === 'notebook' && queryKey[1] === scope
    && (!workspaceId || queryKey[2] === workspaceId) && queryKey[3] === 'chat'
    && queryKey[4] !== 'messages'
  ) });
}

/** Only a confirmed fresh session is known to have an empty persisted history. */
export function seedCreatedChatSession(session: Partial<AISession>, workspaceId: string | null, authScope: string) {
  if (!session.sessionId || !session.agentId || !session.createdAt || session.id === undefined) return;
  const client = getNotebookQueryClient();
  const scope = notebookQueryKey(workspaceId);
  if (scope[1] !== authScope) return;
  const messages: ChatSessionMessagesPayload = {
    success: true, messages: [], hasMoreBefore: false,
    oldestTimestamp: null, oldestMessageId: null, oldestSequence: null,
  };
  const messageKey = [...scope, ...chatMessageResource({ workspaceId, agentId: session.agentId, sessionId: session.sessionId })];
  // Never replace a page delivered by a live refresh while creation was pending.
  if (!client.getQueryData(messageKey)) client.setQueryData(messageKey, messages);
  const bootstrapKey = [...scope, 'chat', 'bootstrap', session.sessionId];
  if (!client.getQueryData(bootstrapKey)) client.setQueryData(bootstrapKey, { session, messages });
}

export async function fetchChatSessionBootstrap(input: {
  sessionId: string; workspaceId?: string | null; signal?: AbortSignal;
}): Promise<{ session: AISession; messages: ChatSessionMessagesPayload }> {
  const client = getNotebookQueryClient();
  const scope = notebookQueryKey(input.workspaceId ?? null);
  const result = await fetchNotebookQuery({
    workspaceId: input.workspaceId ?? null,
    resource: ['chat', 'bootstrap', input.sessionId],
    staleTime: 10_000,
    signal: input.signal,
    queryFn: async ({ signal }) => {
      const clientReadStartedAt = nextChatSnapshotTimestamp();
      const params = new URLSearchParams();
      if (input.workspaceId) params.set('workspaceId', input.workspaceId);
      const response = await fetch(`/api/sessions/${encodeURIComponent(input.sessionId)}/bootstrap?${params}`, {
        signal, credentials: 'include', cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || payload.session?.sessionId !== input.sessionId
        || !payload.messages?.success || !Array.isArray(payload.messages.messages)) {
        throw new Error(payload.error || 'Failed to load chat session.');
      }
      return { session: payload.session as AISession, messages: { ...payload.messages, clientReadStartedAt } as ChatSessionMessagesPayload };
    },
  });
  if (scope[1] === notebookQueryKey(input.workspaceId ?? null)[1]) {
    const messageKey = [...scope, ...chatMessageResource({ ...input, agentId: result.session.agentId ?? DEFAULT_AGENT_ID })];
    // A newer message event/page already in the cache takes precedence.
    if (!client.getQueryData(messageKey)) client.setQueryData(messageKey, result.messages);
  }
  return result;
}
