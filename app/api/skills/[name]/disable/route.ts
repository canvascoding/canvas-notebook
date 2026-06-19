import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { disableSkillInConfig, resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
      errorMessage: 'Forbidden: plugin and skill sharing permission required',
    });
    if (!skillPermission.ok) return skillPermission.response;

    const { name } = await params;
    
    // Read current config
    const config = await readPiRuntimeConfig();
    const allSkills = await loadSkillsFromDisk();
    const allSkillNames = allSkills.map((skill) => skill.name);
    const nextEnabledSkills = disableSkillInConfig(name, config.enabledSkills, allSkillNames);

    if (JSON.stringify(nextEnabledSkills) !== JSON.stringify(config.enabledSkills || [])) {
      config.enabledSkills = nextEnabledSkills;
      config.updatedAt = new Date().toISOString();
      config.updatedBy = skillPermission.session.user.email || 'unknown';
      await writePiRuntimeConfig(config);
    }

    return NextResponse.json({
      success: true,
      message: `Skill "${name}" disabled`,
      enabledSkills: Array.from(resolveEnabledSkillNames(allSkillNames, config.enabledSkills)),
    });
  } catch (error) {
    console.error('[Skills API] Error disabling skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disable skill' },
      { status: 500 }
    );
  }
}
