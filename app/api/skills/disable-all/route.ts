import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
import { DISABLED_ALL_SKILLS_SENTINEL } from '@/app/lib/skills/enabled-skills';
import { writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

export async function POST(request: Request) {
  try {
    const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
      errorMessage: 'Forbidden: plugin and skill sharing permission required',
    });
    if (!skillPermission.ok) return skillPermission.response;

    const scope = { userId: skillPermission.session.user.id };
    
    // Load all available skills
    const allSkills = await loadSkillsFromDisk(undefined, scope);
    
    // Empty enabledSkills means "all enabled", so use the sentinel to disable every skill.
    await writeEnabledSkillsForScope([DISABLED_ALL_SKILLS_SENTINEL], {
      scope,
      updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
    });
    await recordAuditEvent({
      organizationId: skillPermission.state.organizationId,
      userId: skillPermission.session.user.id,
      source: 'skills',
      eventType: 'plugin',
      entityType: 'canvas_skill_settings',
      action: 'skills.disable_all',
      status: 'success',
      summary: 'All skills disabled.',
      metadata: {
        skillCount: allSkills.length,
      },
    });
    
    return NextResponse.json({
      success: true,
      message: `All ${allSkills.length} skills disabled`,
      enabledSkills: [],
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
