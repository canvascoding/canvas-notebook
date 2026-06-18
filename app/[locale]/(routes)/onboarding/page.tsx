import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import { getUserPreferredTimeZone } from '@/app/lib/user-preferences';
import OnboardingWizard from './onboarding-wizard';

export const dynamic = 'force-dynamic';

type OnboardingPageProps = {
  searchParams: Promise<{ key?: string | string[] }>;
};

function getInitialLicenseKey(keyParam?: string | string[]) {
  return Array.isArray(keyParam) ? keyParam[0] || '' : keyParam || '';
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const locale = await getLocale();
  const params = await searchParams;

  if (!isOnboardingEnabled()) {
    redirect({ href: '/', locale });
  }

  const session = await requirePageSession({ allowIncompleteOnboarding: true });
  if (!session) return null;

  if (await isOnboardingComplete()) {
    redirect({ href: '/', locale });
  }

  const initialTimeZone = await getUserPreferredTimeZone(session.user.id);

  return (
    <OnboardingWizard
      defaultEmail={session.user.email ?? ''}
      initialLicenseKey={getInitialLicenseKey(params.key)}
      initialTimeZone={initialTimeZone}
    />
  );
}
