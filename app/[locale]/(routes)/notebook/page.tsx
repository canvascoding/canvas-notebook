import { DashboardShell } from '@/app/components/DashboardShell';
import { requirePageSession } from '@/app/lib/auth-guards';
import { isOnboardingEnabled } from '@/app/lib/onboarding/status';

export default async function NotebookPage() {
  await requirePageSession();

  return <DashboardShell hintEnabled={isOnboardingEnabled()} />;
}
