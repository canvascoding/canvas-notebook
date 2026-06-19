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
    
    // Disable all skills by adding all to enabledSkills (empty list = all enabled, so we need to add all)
    // Actually, to disable all, we need to set enabledSkills to a list that doesn't include any
    // But since empty list means "all enabled", we need a different approach
    // Let's add a dummy entry that won't match any real skill
    config.enabledSkills = ['__none__'];
    config.updatedAt = new Date().toISOString();
    config.updatedBy = skillPermission.session.user.email || 'unknown';
    
    // Write updated config
    await writePiRuntimeConfig(config);
    
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
