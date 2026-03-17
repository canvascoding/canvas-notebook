import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/app/lib/auth';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';

export async function requirePageSession(options?: { allowIncompleteOnboarding?: boolean }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  if (!options?.allowIncompleteOnboarding && isOnboardingEnabled() && !(await isOnboardingComplete())) {
    redirect('/onboarding');
  }

  return session;
}
