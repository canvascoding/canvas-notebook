import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';

type SearchParamsReader = Pick<URLSearchParams, 'get'>;

export type ChatNavigationIntent = {
  sessionId: string | null;
  workspaceId: string | null;
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
  const workspaceId = normalizeQueryValue(searchParams.get('workspaceId'));
  const chatMode = normalizeQueryValue(searchParams.get('chat'))?.toLowerCase();

  return {
    sessionId,
    workspaceId,
    shouldOpenChat: Boolean(sessionId) || chatMode === 'open',
  };
}

export function buildChatSessionHref(
  href: string,
  sessionId: string,
  workspaceId?: string | null,
  options: { openChat?: boolean } = {},
): string {
  const [hrefWithoutHash, hash = ''] = href.split('#', 2);
  const [pathname, query = ''] = hrefWithoutHash.split('?', 2);
  const params = new URLSearchParams(query);

  params.set('session', sessionId);
  if (workspaceId?.trim()) {
    params.set('workspaceId', workspaceId.trim());
  }
  if (options.openChat !== false) {
    params.set('chat', 'open');
  }

  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}

export function getNotebookNavigationIntent(searchParams: SearchParamsReader): NotebookNavigationIntent {
  const chatIntent = getChatNavigationIntent(searchParams);
  const path = normalizeChatFilePath(searchParams.get('path') || '') || null;

  return {
    ...chatIntent,
    path,
  };
}
