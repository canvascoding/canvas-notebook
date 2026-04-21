import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { PresetBuilder } from '@/app/apps/studio/components/presets/PresetBuilder';

export default async function StudioPresetNewPage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')} hintPage="studio">
      <div className="p-4 md:p-6">
        <PresetBuilder />
      </div>
    </SuitePageLayout>
  );
}
