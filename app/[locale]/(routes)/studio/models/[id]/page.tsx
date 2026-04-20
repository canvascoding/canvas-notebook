import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ModelDetailDialog } from '@/app/apps/studio/components/models/ModelDetailDialog';

interface StudioModelDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudioModelDetailPage({ params }: StudioModelDetailPageProps) {
  await requirePageSession();
  const t = await getTranslations('studio');
  const { id } = await params;

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <ModelDetailDialog entityId={id} entityType="product" />
      </div>
    </SuitePageLayout>
  );
}