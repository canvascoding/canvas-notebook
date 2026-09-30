import { headers } from 'next/headers';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/app/lib/auth';
import { hasAnyAuthUser } from '@/app/lib/auth-setup';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import { getUserOnboardingState, getUserPreferredLocale } from '@/app/lib/user-preferences';
import LoginClient from './login-client';
import { redirect as redirectToPath } from 'next/navigation';
import { localizedAppReturnTo } from '@/app/lib/auth/return-to';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  
  if (session) {
    const preferredLocale = await getUserPreferredLocale(session.user.id).catch(() => locale);
    if (isOnboardingEnabled() && !(await isOnboardingComplete())) {
      redirect({ href: '/onboarding', locale: preferredLocale });
    }
    if (isOnboardingEnabled() && (await getUserOnboardingState(session.user.id)).step !== 'complete') {
      redirect({ href: '/onboarding', locale: preferredLocale });
    }
    const params = await searchParams;
    redirectToPath(localizedAppReturnTo(params.from, preferredLocale));
  }

  if (!(await hasAnyAuthUser())) {
    redirect({ href: '/setup', locale });
  }

  return <LoginClient />;
}
