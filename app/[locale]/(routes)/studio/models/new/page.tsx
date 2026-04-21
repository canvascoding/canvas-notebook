import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ModelCreateDialog } from '@/app/apps/studio/components/models/ModelCreateDialog';

export default async function StudioModelNewPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requirePageSession();
  const t = await getTranslations('studio');
  const params = await searchParams;
  const entityType = params.type === 'persona' ? 'persona' : params.type === 'style' ? 'style' : 'product';

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <ModelCreateDialog entityType={entityType} />
      </div>
    </SuitePageLayout>
  );
}