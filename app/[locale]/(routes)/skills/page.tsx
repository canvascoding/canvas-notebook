import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { requirePageSession } from '@/app/lib/auth-guards';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import SkillsPageClient from './SkillsPageClient';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skills');

  return {
    title: t('metadataTitle'),
    description: t('metadataDescription'),
  };
}

export default async function SkillsPage() {
  const session = await requirePageSession();
  const t = await getTranslations('skills');

  const username = session?.user?.name || session?.user?.email || 'User';
  
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
    <SuitePageLayout title={t('title')} username={username} showLogo>
      <SkillsPageClient
        skills={skills}
        stats={stats}
      />
    </SuitePageLayout>
  );
}
