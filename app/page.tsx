import { getSession } from '@/app/lib/auth/session';
import { redirect } from 'next/navigation';
import { DashboardShell } from './components/DashboardShell';

export default async function Home() {
  const session = await getSession();

  if (!session.isLoggedIn) {
    redirect('/login');
  }

  return <DashboardShell username={session.username} />;
}
