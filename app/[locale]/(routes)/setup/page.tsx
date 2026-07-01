import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { auth } from '@/app/lib/auth';
import { hasAnyAuthUser } from '@/app/lib/auth-setup';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import SetupClient from './setup-client';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const [session, locale] = await Promise.all([
    auth.api.getSession({ headers: await headers() }),
    getLocale(),
  ]);

  if (session) {
    if (isOnboardingEnabled() && !(await isOnboardingComplete())) {
      redirect({ href: '/onboarding', locale });
    }
    redirect({ href: '/', locale });
  }

  if (await hasAnyAuthUser()) {
    redirect({ href: '/login', locale });
  }

  return <SetupClient />;
}
