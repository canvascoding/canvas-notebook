import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { BulkGenerateView } from '@/app/apps/studio/components/bulk/BulkGenerateView';

export default async function StudioBulkPage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <BulkGenerateView />
      </div>
    </SuitePageLayout>
  );
}