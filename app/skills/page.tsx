import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/app/lib/auth';
import { loadSkillsFromDisk, getSkillStats } from '@/app/lib/skills/skill-loader';
import SkillsPageClient from './SkillsPageClient';

export const metadata: Metadata = {
  title: 'Skill Gallery | Canvas Studios Suite',
  description: 'Browse and manage Canvas Notebook skills.',
};

export default async function SkillsPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  const username = session.user.name || session.user.email;
  const skills = await loadSkillsFromDisk();
  const stats = await getSkillStats();

  return (
    <SkillsPageClient 
      skills={skills} 
      stats={stats} 
      username={username}
    />
  );
}
