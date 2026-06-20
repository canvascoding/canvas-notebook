import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { enableSkillInConfig, resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

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
    const scope = { userId: skillPermission.session.user.id };
    
    const enabledSkills = await readEnabledSkillsForScope(scope);
    const allSkills = await loadSkillsFromDisk(undefined, scope);
    const allSkillNames = allSkills.map((skill) => skill.name);
    const nextEnabledSkills = enableSkillInConfig(name, enabledSkills, allSkillNames);

    if (JSON.stringify(nextEnabledSkills) !== JSON.stringify(enabledSkills || [])) {
      await writeEnabledSkillsForScope(nextEnabledSkills, {
        scope,
        updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Skill "${name}" enabled`,
      enabledSkills: Array.from(resolveEnabledSkillNames(allSkillNames, nextEnabledSkills)),
    });
  } catch (error) {
    console.error('[Skills API] Error enabling skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to enable skill' },
      { status: 500 }
    );
  }
}
