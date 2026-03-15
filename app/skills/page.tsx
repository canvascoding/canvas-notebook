import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';
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
  
  // Load enabled skills from config to set correct initial state
  const piConfig = await readPiRuntimeConfig();
  const enabledSkills = piConfig.enabledSkills || [];
  
  // Pass enabledSkills to loadSkillsFromDisk so skills have correct enabled status from start
  const skills = await loadSkillsFromDisk(enabledSkills);
  
  // Calculate stats based on actual enabled status
  const enabledCount = skills.filter(s => s.enabled).length;
  const stats = {
    total: skills.length,
    enabled: enabledCount,
    disabled: skills.length - enabledCount,
  };

  return (
    <SkillsPageClient 
      skills={skills} 
      stats={stats} 
      username={username}
    />
  );
}
