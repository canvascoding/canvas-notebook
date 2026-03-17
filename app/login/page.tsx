import { redirect } from 'next/navigation';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import LoginClient from './login-client';

export default async function LoginPage() {
  if (isOnboardingEnabled() && !(await isOnboardingComplete())) {
    redirect('/onboarding');
  }
  return <LoginClient />;
}
