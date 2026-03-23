import { headers } from 'next/headers';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/app/lib/auth';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import LoginClient from './login-client';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  
  if (session) {
    if (isOnboardingEnabled() && !(await isOnboardingComplete())) {
      redirect({ href: '/onboarding', locale });
    }
    redirect({ href: '/', locale });
  }

  return <LoginClient />;
}
