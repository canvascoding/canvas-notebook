import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = await readPiRuntimeConfig();
    const skills = await loadSkillsFromDisk(config.enabledSkills);
    const stats = {
      total: skills.length,
      enabled: skills.filter((skill) => skill.enabled).length,
      disabled: skills.filter((skill) => !skill.enabled).length,
    };

    return NextResponse.json({
      success: true,
      skills,
      stats,
    });
  } catch (error) {
    console.error('[Skills API] Error loading skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skills' },
      { status: 500 }
    );
  }
}
