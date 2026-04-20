import { DashboardShell } from '@/app/components/DashboardShell';
import { requirePageSession } from '@/app/lib/auth-guards';

export default async function NotebookPage() {
  await requirePageSession();

  return <DashboardShell />;
}
