import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { headers } from 'next/headers';

export async function GET() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Read current config
    const config = await readPiRuntimeConfig();
    
    // Handle missing enabledSkills field (backward compatibility)
    const enabledSkills = config.enabledSkills || [];
    
    return NextResponse.json({
      success: true,
      enabledSkills: enabledSkills,
      // If enabledSkills is empty or undefined, all skills are enabled by default
      allEnabled: !enabledSkills || enabledSkills.length === 0,
    });
  } catch (error) {
    console.error('[Skills API] Error reading skill status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read skill status' },
      { status: 500 }
    );
  }
}
