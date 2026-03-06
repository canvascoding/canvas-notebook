import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { DashboardShell } from '@/app/components/DashboardShell';
import { auth } from '@/app/lib/auth';

export default async function NotebookPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  return <DashboardShell username={session.user.name || session.user.email} />;
}
