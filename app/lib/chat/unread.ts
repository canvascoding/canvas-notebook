type UnreadDateInput = Date | string | number | null | undefined;

export type ChatUnreadSessionState = {
  sessionId: string;
  lastMessageAt?: string | Date | null;
  lastViewedAt?: string | Date | null;
  hasUnread?: boolean;
  title?: string | null;
};

export type ChatSessionUpdate = {
  sessionId: string;
  lastMessageAt: string;
  title?: string | null;
};

function toTimestamp(value: UnreadDateInput): number | null {
  if (!value) {
    return null;
  }

  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function hasUnreadAssistantResponse(
  lastMessageAt?: UnreadDateInput,
  lastViewedAt?: UnreadDateInput,
): boolean {
  const lastMessageTimestamp = toTimestamp(lastMessageAt);
  if (lastMessageTimestamp === null) {
    return false;
  }

  const lastViewedTimestamp = toTimestamp(lastViewedAt);
  if (lastViewedTimestamp === null) {
    return true;
  }

  return lastMessageTimestamp > lastViewedTimestamp;
}

export function applySessionUnreadUpdate<TSession extends ChatUnreadSessionState>(
  session: TSession,
  update: ChatSessionUpdate,
  options: {
    isCurrentVisibleSession: boolean;
    title?: string | null;
  },
): TSession {
  const nextLastViewedAt = options.isCurrentVisibleSession
    ? update.lastMessageAt
    : (session.lastViewedAt ?? null);

  return {
    ...session,
    lastMessageAt: update.lastMessageAt,
    ...(options.title ? { title: options.title } : {}),
    lastViewedAt: nextLastViewedAt,
    hasUnread: !options.isCurrentVisibleSession && hasUnreadAssistantResponse(update.lastMessageAt, nextLastViewedAt),
  };
}
