import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

export async function POST(request: Request) {
  try {
    const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
      errorMessage: 'Forbidden: plugin and skill sharing permission required',
    });
    if (!skillPermission.ok) return skillPermission.response;

    // Read current config
    const config = await readPiRuntimeConfig();
    
    // Load all available skills
    const allSkills = await loadSkillsFromDisk();
    const allSkillNames = allSkills.map(s => s.name);
    
    // Enable all skills by setting enabledSkills to empty array (which means all enabled)
    config.enabledSkills = [];
    config.updatedAt = new Date().toISOString();
    config.updatedBy = skillPermission.session.user.email || 'unknown';
    
    // Write updated config
    await writePiRuntimeConfig(config);
    
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
