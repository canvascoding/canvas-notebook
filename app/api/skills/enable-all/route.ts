import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';
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
    const allSkillNames = allSkills.map(s => s.name);
    
    // Enable all skills by setting enabledSkills to empty array (which means all enabled)
    await writeEnabledSkillsForScope([], {
      scope,
      updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
    });
    
    return NextResponse.json({
      success: true,
      message: `All ${allSkillNames.length} skills enabled`,
      enabledSkills: [],
      allEnabled: true,
    });
  } catch (error) {
    console.error('[Skills API] Error enabling all skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to enable all skills' },
      { status: 500 }
    );
  }
}
