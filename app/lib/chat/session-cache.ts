import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { getChatMessageDbId, getChatMessageSequence, getChatMessageTimestamp } from '@/app/lib/chat/message-metadata';
import { normalizeSessionRuntimePhase } from '@/app/lib/chat/runtime-message-utils';
import type { AISession, CachedChatSession, ChatMessage, ChatSessionCacheStore } from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

const CHAT_AGENT_ID = DEFAULT_AGENT_ID;
const CHAT_SESSION_CACHE_VERSION = 1;
const CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY = 'canvas.chat.sessionMessages.v1';
const CHAT_SESSION_MESSAGE_CACHE_MAX_ENTRIES = 6;
const CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES = 120;
const CHAT_SESSION_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MODEL_ID = '';

const inMemoryChatSessionCache = new Map<string, CachedChatSession>();
let hasHydratedChatSessionCache = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getChatSessionCacheKey(agentId: string | null | undefined, sessionId: string): string {
  return `${agentId || CHAT_AGENT_ID}:${sessionId}`;
}

export function isCacheableMessageSet(messages: ChatMessage[]): boolean {
  if (messages.length === 0) {
    return false;
  }

  if (messages.length === 1) {
    const [message] = messages;
    if (message.type === 'system' && (message.status === 'pending' || message.status === 'error')) {
      return false;
    }
  }

  return true;
}

function normalizeCachedSessionEntry(value: unknown): CachedChatSession | null {
  if (!isRecord(value) || value.version !== CHAT_SESSION_CACHE_VERSION) {
    return null;
  }

  const sessionValue = value.session;
  const messagesValue = value.messages;
  const cachedAt = typeof value.cachedAt === 'number' ? value.cachedAt : 0;

  if (!isRecord(sessionValue) || !Array.isArray(messagesValue) || !cachedAt) {
    return null;
  }

  const sessionId = typeof sessionValue.sessionId === 'string' ? sessionValue.sessionId : '';
  if (!sessionId) {
    return null;
  }

  const workspaceValue = isRecord(sessionValue.workspace) ? sessionValue.workspace : null;
  const workspaceType = workspaceValue?.workspaceType;

  const session: AISession = {
    id: typeof sessionValue.id === 'number' ? sessionValue.id : cachedAt,
    sessionId,
    title: typeof sessionValue.title === 'string' ? sessionValue.title : null,
    agentId: typeof sessionValue.agentId === 'string' ? sessionValue.agentId : CHAT_AGENT_ID,
    model: typeof sessionValue.model === 'string' ? sessionValue.model : DEFAULT_MODEL_ID,
    provider: typeof sessionValue.provider === 'string' ? sessionValue.provider : null,
    thinkingLevel: typeof sessionValue.thinkingLevel === 'string' ? sessionValue.thinkingLevel as PiThinkingLevel : null,
    createdAt: typeof sessionValue.createdAt === 'string' ? sessionValue.createdAt : new Date(cachedAt).toISOString(),
    engine: sessionValue.engine === 'legacy' ? 'legacy' : 'pi',
    lastMessageAt: typeof sessionValue.lastMessageAt === 'string' ? sessionValue.lastMessageAt : null,
    lastViewedAt: typeof sessionValue.lastViewedAt === 'string' ? sessionValue.lastViewedAt : null,
    runtimePhase: normalizeSessionRuntimePhase(sessionValue.runtimePhase),
    runtimeActiveToolName: typeof sessionValue.runtimeActiveToolName === 'string' ? sessionValue.runtimeActiveToolName : null,
    hasUnread: typeof sessionValue.hasUnread === 'boolean' ? sessionValue.hasUnread : false,
    workspace: workspaceValue && typeof workspaceValue.workspaceId === 'string'
      ? {
          workspaceId: workspaceValue.workspaceId,
          workspaceType: workspaceType === 'team' || workspaceType === 'project' ? workspaceType : 'personal',
          workspaceName: typeof workspaceValue.workspaceName === 'string' ? workspaceValue.workspaceName : 'Workspace',
          organizationId: typeof workspaceValue.organizationId === 'string' ? workspaceValue.organizationId : null,
          rootRelativePath: typeof workspaceValue.rootRelativePath === 'string' ? workspaceValue.rootRelativePath : null,
          legacy: Boolean(workspaceValue.legacy),
        }
      : null,
    creator: isRecord(sessionValue.creator)
      ? {
          name: typeof sessionValue.creator.name === 'string' ? sessionValue.creator.name : null,
          email: typeof sessionValue.creator.email === 'string' ? sessionValue.creator.email : null,
        }
      : undefined,
  };

  return {
    version: CHAT_SESSION_CACHE_VERSION,
    session,
    messages: messagesValue as ChatMessage[],
    hasMoreBefore: typeof value.hasMoreBefore === 'boolean' ? value.hasMoreBefore : false,
    oldestTimestamp: typeof value.oldestTimestamp === 'number' ? value.oldestTimestamp : null,
    oldestMessageId: typeof value.oldestMessageId === 'number' ? value.oldestMessageId : null,
    oldestSequence: typeof value.oldestSequence === 'number' ? value.oldestSequence : null,
    cachedAt,
  };
}

function hydrateChatSessionCacheFromStorage() {
  if (hasHydratedChatSessionCache || typeof window === 'undefined') {
    return;
  }

  hasHydratedChatSessionCache = true;

  try {
    const stored = window.sessionStorage.getItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY);
    if (!stored) {
      return;
    }

    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed) || parsed.version !== CHAT_SESSION_CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }

    for (const candidate of parsed.entries) {
      const entry = normalizeCachedSessionEntry(candidate);
      if (!entry || Date.now() - entry.cachedAt > CHAT_SESSION_MESSAGE_CACHE_TTL_MS) {
        continue;
      }
      inMemoryChatSessionCache.set(getChatSessionCacheKey(entry.session.agentId, entry.session.sessionId), entry);
    }
  } catch (error) {
    console.warn('[CanvasAgentChat] Failed to hydrate chat session cache', error);
  }
}

function trimCachedMessages(messages: ChatMessage[]): { messages: ChatMessage[]; droppedEarlierMessages: boolean } {
  if (messages.length <= CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES) {
    return { messages, droppedEarlierMessages: false };
  }

  return {
    messages: messages.slice(-CHAT_SESSION_MESSAGE_CACHE_MAX_MESSAGES),
    droppedEarlierMessages: true,
  };
}

export function buildCachedChatSessionEntry(params: {
  session: AISession;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: number | null;
  oldestSequence: number | null;
}): CachedChatSession {
  const trimmed = trimCachedMessages(params.messages);
  const firstMessage = trimmed.messages[0];
  const trimmedOldestTimestamp = trimmed.droppedEarlierMessages
    ? getChatMessageTimestamp(firstMessage) ?? params.oldestTimestamp
    : params.oldestTimestamp;
  const trimmedOldestMessageId = trimmed.droppedEarlierMessages
    ? getChatMessageDbId(firstMessage) ?? params.oldestMessageId
    : params.oldestMessageId;
  const trimmedOldestSequence = trimmed.droppedEarlierMessages
    ? getChatMessageSequence(firstMessage) ?? params.oldestSequence
    : params.oldestSequence;

  return {
    version: CHAT_SESSION_CACHE_VERSION,
    session: {
      ...params.session,
      title: params.session.title ?? null,
    },
    messages: trimmed.messages,
    hasMoreBefore: params.hasMoreBefore || trimmed.droppedEarlierMessages,
    oldestTimestamp: trimmedOldestTimestamp,
    oldestMessageId: trimmedOldestMessageId,
    oldestSequence: trimmedOldestSequence,
    cachedAt: Date.now(),
  };
}

export function rememberChatSessionCacheEntry(entry: CachedChatSession) {
  inMemoryChatSessionCache.set(getChatSessionCacheKey(entry.session.agentId, entry.session.sessionId), entry);
}

export function persistChatSessionCache() {
  if (typeof window === 'undefined') {
    return;
  }

  const entries = Array.from(inMemoryChatSessionCache.values())
    .filter((entry) => Date.now() - entry.cachedAt <= CHAT_SESSION_MESSAGE_CACHE_TTL_MS)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .slice(0, CHAT_SESSION_MESSAGE_CACHE_MAX_ENTRIES);
  const store: ChatSessionCacheStore = {
    version: CHAT_SESSION_CACHE_VERSION,
    entries,
  };

  try {
    window.sessionStorage.setItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    try {
      window.sessionStorage.setItem(
        CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY,
        JSON.stringify({ ...store, entries: entries.slice(0, 1) }),
      );
    } catch {
      window.sessionStorage.removeItem(CHAT_SESSION_MESSAGE_CACHE_STORAGE_KEY);
    }
    console.warn('[CanvasAgentChat] Failed to persist full chat session cache', error);
  }
}

export function readCachedChatSession(agentId: string | null | undefined, sessionId: string): CachedChatSession | null {
  hydrateChatSessionCacheFromStorage();
  const cacheKey = getChatSessionCacheKey(agentId, sessionId);
  const entry = inMemoryChatSessionCache.get(cacheKey) || null;
  if (!entry || Date.now() - entry.cachedAt > CHAT_SESSION_MESSAGE_CACHE_TTL_MS) {
    if (entry) {
      inMemoryChatSessionCache.delete(cacheKey);
      persistChatSessionCache();
    }
    return null;
  }
  return entry;
}

export function readLatestCachedChatSession(sessionId: string): CachedChatSession | null {
  hydrateChatSessionCacheFromStorage();
  const entries = Array.from(inMemoryChatSessionCache.values())
    .filter((entry) => entry.session.sessionId === sessionId && Date.now() - entry.cachedAt <= CHAT_SESSION_MESSAGE_CACHE_TTL_MS)
    .sort((a, b) => b.cachedAt - a.cachedAt);
  return entries[0] || null;
}

export function removeCachedChatSession(sessionId: string, agentId?: string | null) {
  hydrateChatSessionCacheFromStorage();
  for (const [cacheKey, entry] of inMemoryChatSessionCache.entries()) {
    const matchesSession = entry.session.sessionId === sessionId;
    const matchesAgent = !agentId || entry.session.agentId === agentId;
    if (matchesSession && matchesAgent) {
      inMemoryChatSessionCache.delete(cacheKey);
    }
  }
  persistChatSessionCache();
}

export function updateCachedChatSessionTitle(sessionId: string, title: string, agentId?: string | null) {
  hydrateChatSessionCacheFromStorage();
  let changed = false;
  for (const [cacheKey, entry] of inMemoryChatSessionCache.entries()) {
    const matchesSession = entry.session.sessionId === sessionId;
    const matchesAgent = !agentId || entry.session.agentId === agentId;
    if (!matchesSession || !matchesAgent) {
      continue;
    }
    inMemoryChatSessionCache.set(cacheKey, {
      ...entry,
      session: {
        ...entry.session,
        title,
      },
      cachedAt: Date.now(),
    });
    changed = true;
  }
  if (changed) {
    persistChatSessionCache();
  }
}
