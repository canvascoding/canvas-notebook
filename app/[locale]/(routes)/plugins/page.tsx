import { getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { PluginsAppClient } from '@/app/components/plugins/PluginsAppClient';

export default async function PluginsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') query.set(key, value);
  }
  await requirePageSession({ returnTo: `/plugins${query.size ? `?${query}` : ''}` });
  const t = await getTranslations('home.apps.plugins');
  return (
    <SuitePageLayout title={t('title')} hintEnabled={false}>
      <PluginsAppClient />
    </SuitePageLayout>
  );
}
