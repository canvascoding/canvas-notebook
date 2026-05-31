'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { usePathname } from '@/i18n/navigation';

export function TodosShell({ children, hintEnabled = true }: { children: ReactNode; hintEnabled?: boolean }) {
  const tCommon = useTranslations('common');
  const tTodos = useTranslations('todos');
  const pathname = usePathname();
  const requestContext = useMemo<ChatRequestContext>(
    () => ({ currentPage: pathname ?? '/todos' }),
    [pathname],
  );

  return (
    <ChatDockShell
      title={tTodos('title')}
      backHref="/"
      backLabel={tCommon('suite')}
      requestContext={requestContext}
      storageKeyPrefix="todos"
      hintPage="todos"
      hintEnabled={hintEnabled}
      defaultChatVisible={false}
    >
      {children}
    </ChatDockShell>
  );
}
