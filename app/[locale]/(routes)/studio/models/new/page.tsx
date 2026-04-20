import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ModelCreateDialog } from '@/app/apps/studio/components/models/ModelCreateDialog';

export default async function StudioModelNewPage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <ModelCreateDialog />
      </div>
    </SuitePageLayout>
  );
}