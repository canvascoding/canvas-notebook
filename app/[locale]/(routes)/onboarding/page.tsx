import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled, isOnboardingComplete, isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { getInstanceOnboardingStep, getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { isAdminUser } from '@/app/lib/admin-auth';
import { getUserOnboardingState } from '@/app/lib/user-preferences';
import { resolveOnboardingPhase } from '@/app/lib/onboarding/flow';
import { PublicBrandLogo } from '@/app/components/branding/PublicBrandLogo';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import OnboardingWizard from './onboarding-wizard';
import { OnboardingWaitingActions } from './onboarding-waiting-actions';

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
          <PublicBrandLogo
            alt="Canvas Notebook"
            width={160}
            height={48}
            className="h-12 max-w-40 object-contain"
            fallbackClassName="w-12 border border-border object-cover"
            brandClassName="w-auto"
          />
          <p className="mt-4 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">Canvas Notebook</p>
          <h1 className="mt-3 text-2xl font-semibold">{t('instanceSetupWaitingTitle')}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t('instanceSetupWaitingDescription')}
          </p>
          <OnboardingWaitingActions />
        </section>
      </main>
    );
  }

  const initialTimeZone = await getServerPreferredTimeZone();
  const initialStep = instanceComplete
    ? (userOnboarding.step === 'complete' ? 'done' : userOnboarding.step)
    : await getInstanceOnboardingStep();
  const initialUserProfile = await resolveUserProfile({
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    locale,
  });

  return (
    <OnboardingWizard
      defaultEmail={session.user.email ?? ''}
      initialLicenseKey={getInitialLicenseKey(params.key)}
      initialTimeZone={initialTimeZone}
      mode={phase === 'instance' ? 'instance' : 'user'}
      initialStep={initialStep}
      initialUserProfile={initialUserProfile}
      guidedHintsEnabled={isOnboardingHintsEnabled()}
    />
  );
}
