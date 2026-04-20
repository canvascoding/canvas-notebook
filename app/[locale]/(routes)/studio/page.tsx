import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { StudioClient } from '@/app/apps/studio/components/StudioClient';

export default async function StudioPage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <StudioClient />
    </SuitePageLayout>
  );
}