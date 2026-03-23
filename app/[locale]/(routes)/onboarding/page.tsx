import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import OnboardingWizard from './onboarding-wizard';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const locale = await getLocale();

  if (!isOnboardingEnabled()) {
    redirect({ href: '/', locale });
  }

  await requirePageSession({ allowIncompleteOnboarding: true });

  if (await isOnboardingComplete()) {
    redirect({ href: '/', locale });
  }

  return <OnboardingWizard />;
}
