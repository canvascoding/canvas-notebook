import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';

type SearchParamsReader = Pick<URLSearchParams, 'get'>;

export type ChatNavigationIntent = {
  sessionId: string | null;
  shouldOpenChat: boolean;
};

export type NotebookNavigationIntent = ChatNavigationIntent & {
  path: string | null;
};

function normalizeQueryValue(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function getChatNavigationIntent(searchParams: SearchParamsReader): ChatNavigationIntent {
  const sessionId = normalizeQueryValue(searchParams.get('session'));
  const chatMode = normalizeQueryValue(searchParams.get('chat'))?.toLowerCase();

  return {
    sessionId,
    shouldOpenChat: Boolean(sessionId) || chatMode === 'open',
  };
}

export function getNotebookNavigationIntent(searchParams: SearchParamsReader): NotebookNavigationIntent {
  const chatIntent = getChatNavigationIntent(searchParams);
  const path = normalizeChatFilePath(searchParams.get('path') || '') || null;

  return {
    ...chatIntent,
    path,
  };
}
