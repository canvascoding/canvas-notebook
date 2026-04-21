import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { ModelDetailDialog } from '@/app/apps/studio/components/models/ModelDetailDialog';

interface StudioModelDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ type?: string }>;
}

export default async function StudioModelDetailPage({ params, searchParams }: StudioModelDetailPageProps) {
  await requirePageSession();
  const t = await getTranslations('studio');
  const { id } = await params;
  const sp = await searchParams;
  const entityType = sp.type === 'persona' ? 'persona' : 'product';

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <ModelDetailDialog entityId={id} entityType={entityType} />
      </div>
    </SuitePageLayout>
  );
}