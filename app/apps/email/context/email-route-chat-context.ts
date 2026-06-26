import type { ChatRequestContext } from '@/app/lib/chat/types';

export type EmailChatContextMessage = {
  id?: string;
  folder?: string;
  from?: string | null;
  subject?: string | null;
  date?: string | null;
  isRead?: boolean | null;
};

export type EmailChatContextAccount = {
  id?: string;
  emailAddress?: string | null;
};

export function buildEmailPageChatContext(params: {
  account?: EmailChatContextAccount | null;
  activeFolder: string;
  activeFolderName: string;
  filter: 'all' | 'unread';
  pathname?: string | null;
  selectedMessage?: EmailChatContextMessage | null;
  selectedMessageId?: string | null;
  submittedQuery?: string | null;
}): ChatRequestContext {
  const selectedMessage = params.selectedMessage;

  return {
    currentPage: params.pathname || '/emails',
    emailContext: {
      accountEmail: params.account?.emailAddress || undefined,
      accountId: params.account?.id || undefined,
      filter: params.filter,
      folder: params.activeFolder,
      folderName: params.activeFolderName,
      query: params.submittedQuery || undefined,
      selectedMessageDate: selectedMessage?.date || null,
      selectedMessageFolder: selectedMessage?.folder || params.activeFolder,
      selectedMessageFrom: selectedMessage?.from || null,
      selectedMessageId: selectedMessage?.id || params.selectedMessageId || undefined,
      selectedMessageIsRead: selectedMessage?.isRead ?? null,
      selectedMessageSubject: selectedMessage?.subject || null,
    },
  };
}

export function resolveEmailShellRequestContext(
  chatContext: ChatRequestContext | null | undefined,
  pathname: string | null | undefined,
): ChatRequestContext {
  const currentPage = pathname || '/emails';
  return chatContext?.currentPage === currentPage ? chatContext : { currentPage };
}
