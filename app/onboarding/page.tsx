import { redirect } from 'next/navigation';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import OnboardingWizard from './onboarding-wizard';

export default async function OnboardingPage() {
  if (!isOnboardingEnabled()) {
    redirect('/');
  }

  if (await isOnboardingComplete()) {
    redirect('/');
  }

  return <OnboardingWizard />;
}
