import { redirect } from 'next/navigation';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import OnboardingWizard from './onboarding-wizard';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  if (!isOnboardingEnabled()) {
    redirect('/');
  }

  await requirePageSession({ allowIncompleteOnboarding: true });

  if (await isOnboardingComplete()) {
    redirect('/');
  }

  return <OnboardingWizard />;
}
