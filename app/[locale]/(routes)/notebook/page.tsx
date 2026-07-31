import { DashboardShell } from '@/app/components/DashboardShell';
import { EmailChatProvider } from '@/app/apps/email/context/email-chat-context';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';
import { getUserOnboardingState } from '@/app/lib/user-preferences';

export default async function NotebookPage() {
  const session = await requirePageSession();
  const userOnboarding = session ? await getUserOnboardingState(session.user.id) : null;

  return (
    <EmailChatProvider>
      <DashboardShell hintEnabled={isOnboardingHintsEnabled() || userOnboarding?.tour === 'started'} />
    </EmailChatProvider>
  );
}
