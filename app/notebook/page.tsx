import { DashboardShell } from '@/app/components/DashboardShell';
import { requirePageSession } from '@/app/lib/auth-guards';

export default async function NotebookPage() {
  const session = await requirePageSession();

  return <DashboardShell username={session.user.name || session.user.email} />;
}
