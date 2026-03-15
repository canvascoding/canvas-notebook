import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { headers } from 'next/headers';
import { loadSkillsFromDisk } from '@/app/lib/skills/skill-loader';

export async function POST() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

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
    config.updatedBy = session.user.email || 'unknown';
    
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
