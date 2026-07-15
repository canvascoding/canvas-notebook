import { NextResponse } from 'next/server';
import { setAllPersonalOrganizationCapabilityActivations } from '@/app/lib/capabilities/activation-actions';
import { requireActiveCapabilityUser } from '@/app/lib/capabilities/request-auth';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { DISABLED_ALL_SKILLS_SENTINEL, resolveEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

export async function POST(request: Request) {
  try {
    const capabilityUser = await requireActiveCapabilityUser(request);
    if (!capabilityUser.ok) return capabilityUser.response;

    const scope = {
      scopeType: 'user' as const,
      userId: capabilityUser.session.user.id,
      organizationId: capabilityUser.state.organizationId,
    };
    
    // Load all available skills
    const allSkills = await loadSkillsFromDisk(undefined, scope);
    
    // Empty enabledSkills means "all enabled", so use the sentinel to disable optional skills.
    await writeEnabledSkillsForScope([DISABLED_ALL_SKILLS_SENTINEL], {
      scope,
      updatedBy: capabilityUser.session.user.email || capabilityUser.session.user.id,
    });
    const allSkillNames = allSkills.map((skill) => skill.name);
    const enabledSkillNames = Array.from(resolveEnabledSkillNames(allSkillNames, [DISABLED_ALL_SKILLS_SENTINEL]));
    const organizationCapabilityCount = capabilityUser.state.organizationId && capabilityUser.state.permission
      ? await setAllPersonalOrganizationCapabilityActivations({
        context: {
          organizationId: capabilityUser.state.organizationId,
          userId: capabilityUser.session.user.id,
          role: capabilityUser.state.permission.role,
        },
        actorUserId: capabilityUser.session.user.id,
        enabled: false,
      })
      : 0;
    
    return NextResponse.json({
      success: true,
      message: `Optional skills disabled. ${enabledSkillNames.length} core skills and organization-required capabilities remain enabled; ${organizationCapabilityCount} organization preferences changed.`,
      enabledSkills: enabledSkillNames,
      allEnabled: false,
    });
  } catch (error) {
    console.error('[Skills API] Error disabling all skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disable all skills' },
      { status: 500 }
    );
  }
}
