import { NextResponse } from 'next/server';
import { setAllPersonalOrganizationCapabilityActivations } from '@/app/lib/capabilities/activation-actions';
import { requireActiveCapabilityUser } from '@/app/lib/capabilities/request-auth';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { isCoreSkillName } from '@/app/lib/skills/core-skills';
import { resolveEnabledSkillNames, serializeEnabledSkillNames } from '@/app/lib/skills/enabled-skills';
import { readProtectedPersonalSkillNames } from '@/app/lib/skills/personal-skill-activation';
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
    const allSkillNames = allSkills.map(s => s.name);
    
    const protectedNames = await readProtectedPersonalSkillNames(scope);
    const allowedSkillNames = allSkillNames.filter((name) => isCoreSkillName(name) || !protectedNames.has(name.trim().toLowerCase()));
    const nextEnabledSkills = allowedSkillNames.length === allSkillNames.length
      ? []
      : serializeEnabledSkillNames(allowedSkillNames, allSkillNames);
    await writeEnabledSkillsForScope(nextEnabledSkills, {
      scope,
      updatedBy: capabilityUser.session.user.email || capabilityUser.session.user.id,
    });
    const organizationCapabilityCount = capabilityUser.state.organizationId && capabilityUser.state.permission
      ? await setAllPersonalOrganizationCapabilityActivations({
        context: {
          organizationId: capabilityUser.state.organizationId,
          userId: capabilityUser.session.user.id,
          role: capabilityUser.state.permission.role,
        },
        actorUserId: capabilityUser.session.user.id,
        enabled: true,
      })
      : 0;
    
    return NextResponse.json({
      success: true,
      message: `All ${allowedSkillNames.length} available personal skills and ${organizationCapabilityCount} organization capabilities enabled`,
      enabledSkills: nextEnabledSkills,
      allEnabled: nextEnabledSkills.length === 0,
      enabledCount: resolveEnabledSkillNames(allSkillNames, nextEnabledSkills).size,
    });
  } catch (error) {
    console.error('[Skills API] Error enabling all skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to enable all skills' },
      { status: 500 }
    );
  }
}
