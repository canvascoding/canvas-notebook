import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { CreateView } from '@/app/apps/studio/components/create/CreateView';

export default async function StudioCreatePage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')} hintPage="studio" mainClassName="flex-1 min-h-0 overflow-hidden">
      <CreateView />
    </SuitePageLayout>
  );
}
