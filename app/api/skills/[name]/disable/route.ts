import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { headers } from 'next/headers';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { name } = await params;
    
    // Read current config
    const config = await readPiRuntimeConfig();
    
    // Ensure enabledSkills exists (backward compatibility)
    if (!config.enabledSkills) {
      config.enabledSkills = [];
    }
    
    // Remove skill from enabled list
    const index = config.enabledSkills.indexOf(name);
    if (index > -1) {
      config.enabledSkills.splice(index, 1);
      config.updatedAt = new Date().toISOString();
      config.updatedBy = session.user.email || 'unknown';
      
      // Write updated config
      await writePiRuntimeConfig(config);
    }
    
    return NextResponse.json({
      success: true,
      message: `Skill "${name}" disabled`,
      enabledSkills: config.enabledSkills,
    });
  } catch (error) {
    console.error('[Skills API] Error disabling skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disable skill' },
      { status: 500 }
    );
  }
}
