import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { headers } from 'next/headers';

export async function GET() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Read current config
    const config = await readPiRuntimeConfig();
    const skills = await loadSkillsFromDisk();
    const allSkillNames = skills.map((skill) => skill.name);
    const enabledSkillNames = Array.from(resolveEnabledSkillNames(allSkillNames, config.enabledSkills));

    return NextResponse.json({
      success: true,
      enabledSkills: enabledSkillNames,
      allEnabled: enabledSkillNames.length === allSkillNames.length,
    });
  } catch (error) {
    console.error('[Skills API] Error reading skill status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read skill status' },
      { status: 500 }
    );
  }
}
