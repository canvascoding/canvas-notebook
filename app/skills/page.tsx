import type { Metadata } from 'next';

import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { requirePageSession } from '@/app/lib/auth-guards';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import SkillsPageClient from './SkillsPageClient';

export const metadata: Metadata = {
  title: 'Skill Gallery | Canvas Notebook',
  description: 'Browse and manage Canvas Notebook skills.',
};

export default async function SkillsPage() {
  const session = await requirePageSession();

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
    <SuitePageLayout title="Skill Gallery" username={username} showLogo>
      <SkillsPageClient
        skills={skills}
        stats={stats}
      />
    </SuitePageLayout>
  );
}
