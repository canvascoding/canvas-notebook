import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

import { auth } from '@/app/lib/auth';
import { hasAnyAuthUser } from '@/app/lib/auth-setup';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { getUserOnboardingState } from '@/app/lib/user-preferences';
import { safeAppReturnTo } from '@/app/lib/auth/return-to';
import { PAGE_RETURN_TO_HEADER } from '@/app/lib/auth/page-request';

export async function requirePageSession(options?: {
  allowIncompleteOnboarding?: boolean;
  allowIncompleteUserOnboarding?: boolean;
  returnTo?: string;
}) {
  const requestHeaders = await headers();
  const [session, locale] = await Promise.all([
    auth.api.getSession({ headers: requestHeaders }),
    getLocale()
  ]);

  if (!session) {
    if (!(await hasAnyAuthUser())) {
      redirect({ href: '/setup', locale });
    }
    const returnTo = safeAppReturnTo(options?.returnTo ?? requestHeaders.get(PAGE_RETURN_TO_HEADER));
    redirect({ href: returnTo ? `/login?${new URLSearchParams({ from: returnTo })}` : '/login', locale });
  }

  const onboardingEnabled = isOnboardingEnabled();
  const onboardingComplete = onboardingEnabled ? await isOnboardingComplete() : true;

  if (!options?.allowIncompleteOnboarding && onboardingEnabled && !onboardingComplete) {
    redirect({ href: '/onboarding', locale });
  }

  if (
    !options?.allowIncompleteUserOnboarding &&
    onboardingEnabled &&
    onboardingComplete
  ) {
    const onboarding = await getUserOnboardingState(session!.user.id);
    if (onboarding.step !== 'complete') {
      redirect({ href: '/onboarding', locale });
    }
  }

  return session;
}
