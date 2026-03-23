import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

import { auth } from '@/app/lib/auth';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';

export async function requirePageSession(options?: { allowIncompleteOnboarding?: boolean }) {
  const [session, locale] = await Promise.all([
    auth.api.getSession({ headers: await headers() }),
    getLocale()
  ]);

  if (!session) {
    redirect({ href: '/login', locale });
  }

  if (!options?.allowIncompleteOnboarding && isOnboardingEnabled() && !(await isOnboardingComplete())) {
    redirect({ href: '/onboarding', locale });
  }

  return session;
}
