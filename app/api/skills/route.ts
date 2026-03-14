import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { loadSkillsFromDisk, getSkillStats } from '@/app/lib/skills/skill-loader';

export async function GET() {
  const session = await auth.api.getSession({ headers: new Headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const skills = await loadSkillsFromDisk();
    const stats = await getSkillStats();
    
    return NextResponse.json({
      success: true,
      skills,
      stats,
    });
  } catch (error) {
    console.error('[Skills API] Error loading skills:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skills' },
      { status: 500 }
    );
  }
}
