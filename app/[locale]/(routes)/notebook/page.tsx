import { DashboardShell } from '@/app/components/DashboardShell';
import { EmailChatProvider } from '@/app/apps/email/context/email-chat-context';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

export default async function NotebookPage() {
  await requirePageSession();

  return (
    <EmailChatProvider>
      <DashboardShell hintEnabled={isOnboardingHintsEnabled()} />
    </EmailChatProvider>
  );
}
