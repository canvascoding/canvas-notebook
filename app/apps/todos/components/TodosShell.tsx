'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import { useTodoChatContext } from '@/app/apps/todos/context/todo-chat-context';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { usePathname } from '@/i18n/navigation';

export function TodosShell({ children, hintEnabled = true }: { children: ReactNode; hintEnabled?: boolean }) {
  const tTodos = useTranslations('todos');
  const pathname = usePathname();
  const { chatContext } = useTodoChatContext();
  const requestContext = useMemo<ChatRequestContext>(
    () => ({ currentPage: pathname ?? '/todos', todoContext: chatContext?.todoContext }),
    [chatContext, pathname],
  );

  return (
    <ChatDockShell
      title={tTodos('title')}
      backHref="/"
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
