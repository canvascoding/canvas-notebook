import { getTranslations } from 'next-intl/server';

import { EmailClient } from '@/app/apps/email/components/EmailClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default async function EmailsPage() {
  const t = await getTranslations('emails');
  await requirePageSession();

  return (
    <SuitePageLayout title={t('title')} hintPage="emails" hintEnabled={isOnboardingEnabled()}>
      <EmailClient />
    </SuitePageLayout>
  );
}
