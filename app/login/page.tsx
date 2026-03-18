import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/app/lib/auth';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import LoginClient from './login-client';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    if (isOnboardingEnabled() && !(await isOnboardingComplete())) {
      redirect('/onboarding');
    }
    redirect('/');
  }

  return <LoginClient />;
}
