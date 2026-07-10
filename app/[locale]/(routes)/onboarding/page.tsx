import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled, isOnboardingComplete } from '@/app/lib/onboarding/status';
import { getInstanceOnboardingStep, getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { isAdminUser } from '@/app/lib/admin-auth';
import { getUserOnboardingState } from '@/app/lib/user-preferences';
import { resolveOnboardingPhase } from '@/app/lib/onboarding/flow';
import OnboardingWizard from './onboarding-wizard';

export const dynamic = 'force-dynamic';

type OnboardingPageProps = {
  searchParams: Promise<{ key?: string | string[] }>;
};

function getInitialLicenseKey(keyParam?: string | string[]) {
  return Array.isArray(keyParam) ? keyParam[0] || '' : keyParam || '';
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const locale = await getLocale();
  const params = await searchParams;

  if (!isOnboardingEnabled()) {
    redirect({ href: '/', locale });
  }

  const session = await requirePageSession({
    allowIncompleteOnboarding: true,
    allowIncompleteUserOnboarding: true,
  });
  if (!session) return null;

  const instanceComplete = await isOnboardingComplete();
  const userOnboarding = await getUserOnboardingState(session.user.id, {
    missing: instanceComplete ? 'complete' : 'pending',
  });
  const phase = resolveOnboardingPhase({
    instanceComplete,
    isInstanceAdmin: isAdminUser(session.user),
    userOnboarding,
  });
  if (phase === 'complete') {
    redirect({ href: '/', locale });
  }

  if (phase === 'waiting') {
    const t = await getTranslations('onboarding');
    return (
      <main className="mx-auto flex min-h-screen max-w-lg items-center px-6 py-12">
        <section className="w-full border border-border bg-card p-6 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">Canvas Notebook</p>
          <h1 className="mt-3 text-2xl font-semibold">{t('instanceSetupWaitingTitle')}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t('instanceSetupWaitingDescription')}
          </p>
        </section>
      </main>
    );
  }

  const initialTimeZone = await getServerPreferredTimeZone();
  const initialStep = instanceComplete
    ? (userOnboarding.profile === 'pending'
      ? (userOnboarding.step === 'profile'
        ? 'profile'
        : userOnboarding.step === 'workspace'
          ? 'workspace'
          : 'language')
      : (userOnboarding.tour === 'pending' ? 'tour' : 'done'))
    : await getInstanceOnboardingStep();

  return (
    <OnboardingWizard
      defaultEmail={session.user.email ?? ''}
      initialLicenseKey={getInitialLicenseKey(params.key)}
      initialTimeZone={initialTimeZone}
      mode={phase === 'instance' ? 'instance' : 'user'}
      initialStep={initialStep}
    />
  );
}
