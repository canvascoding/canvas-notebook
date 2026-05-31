import { getTranslations } from 'next-intl/server';

import { TodosClient } from '@/app/apps/todos/components/TodosClient';
import { TodosShell } from '@/app/apps/todos/components/TodosShell';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default async function TodosPage() {
  const t = await getTranslations('todos');
  await requirePageSession();

  return (
    <TodosShell hintEnabled={isOnboardingEnabled()}>
      <TodosClient title={t('title')} />
    </TodosShell>
  );
}
