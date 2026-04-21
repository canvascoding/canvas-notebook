import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { PresetBuilder } from '@/app/apps/studio/components/presets/PresetBuilder';

interface StudioPresetDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudioPresetDetailPage({ params }: StudioPresetDetailPageProps) {
  await requirePageSession();
  const t = await getTranslations('studio');
  const { id } = await params;

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <PresetBuilder presetId={id} />
      </div>
    </SuitePageLayout>
  );
}
