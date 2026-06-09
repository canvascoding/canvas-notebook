'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useEmailChatContext } from '@/app/apps/email/context/email-chat-context';
import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { usePathname } from '@/i18n/navigation';

export function EmailShell({ children, hintEnabled = true }: { children: ReactNode; hintEnabled?: boolean }) {
  const tCommon = useTranslations('common');
  const tEmails = useTranslations('emails');
  const pathname = usePathname();
  const { chatContext } = useEmailChatContext();
  const requestContext = useMemo<ChatRequestContext>(
    () => (chatContext?.currentPage === pathname ? chatContext : { currentPage: pathname ?? '/emails' }),
    [chatContext, pathname],
  );

  return (
    <ChatDockShell
      title={tEmails('title')}
      backHref="/"
      backLabel={tCommon('suite')}
      requestContext={requestContext}
      storageKeyPrefix="emails"
      chatVisibleStorageKey="emails.chatVisible"
      hintPage="emails"
      hintEnabled={hintEnabled}
      mainClassName="overflow-hidden"
    >
      {children}
    </ChatDockShell>
  );
}
