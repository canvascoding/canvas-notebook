import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';

export default async function StudioPresetsPage() {
  await requirePageSession();
  const t = await getTranslations('studio');

  return (
    <SuitePageLayout title={t('title')}>
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <p className="text-muted-foreground">{t('comingSoon')}</p>
      </div>
    </SuitePageLayout>
  );
}