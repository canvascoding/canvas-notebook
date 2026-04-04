import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { enableSkillInConfig, resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { headers } from 'next/headers';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { name } = await params;
    
    // Read current config
    const config = await readPiRuntimeConfig();
    const allSkills = await loadSkillsFromDisk();
    const allSkillNames = allSkills.map((skill) => skill.name);
    const nextEnabledSkills = enableSkillInConfig(name, config.enabledSkills, allSkillNames);

    if (JSON.stringify(nextEnabledSkills) !== JSON.stringify(config.enabledSkills || [])) {
      config.enabledSkills = nextEnabledSkills;
      config.updatedAt = new Date().toISOString();
      config.updatedBy = session.user.email || 'unknown';
      await writePiRuntimeConfig(config);
    }

    return NextResponse.json({
      success: true,
      message: `Skill "${name}" enabled`,
      enabledSkills: Array.from(resolveEnabledSkillNames(allSkillNames, config.enabledSkills)),
    });
  } catch (error) {
    console.error('[Skills API] Error enabling skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to enable skill' },
      { status: 500 }
    );
  }
}
