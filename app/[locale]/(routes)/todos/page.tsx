import { getTranslations } from 'next-intl/server';

import { TodosClient } from '@/app/apps/todos/components/TodosClient';
import { TodosShell } from '@/app/apps/todos/components/TodosShell';
import { TodoChatProvider } from '@/app/apps/todos/context/todo-chat-context';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

export default async function TodosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getTranslations('todos');
  const params = await searchParams;
  const returnParams = new URLSearchParams();
  if (typeof params.todo === 'string') returnParams.set('todo', params.todo);
  if (params.todoView === 'page') returnParams.set('todoView', 'page');
  if (typeof params.workspaceId === 'string') returnParams.set('workspaceId', params.workspaceId);
  await requirePageSession({ returnTo: returnParams.has('todo') ? `/todos?${returnParams}` : undefined });

  return (
    <TodoChatProvider>
      <TodosShell hintEnabled={isOnboardingHintsEnabled()}>
        <TodosClient title={t('title')} />
      </TodosShell>
    </TodoChatProvider>
  );
}
