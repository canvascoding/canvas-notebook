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
    const allSkillNames = allSkills.map(s => s.name);
    
    // Enable all skills by setting enabledSkills to empty array (which means all enabled)
    config.enabledSkills = [];
    config.updatedAt = new Date().toISOString();
    config.updatedBy = session.user.email || 'unknown';
    
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
