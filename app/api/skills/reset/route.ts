import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resetCanvasSkillsDirectory } from '@/app/lib/skills/canvas-skill-store';

const RESET_CONFIRMATION = 'DELETE_SKILLS';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({})) as { confirm?: unknown };
    if (body.confirm !== RESET_CONFIRMATION) {
      return NextResponse.json(
        { success: false, error: `Type ${RESET_CONFIRMATION} to reset all skills.` },
        { status: 400 },
      );
    }

    const result = await resetCanvasSkillsDirectory(session.user.email || 'unknown');
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills API] Error resetting skills directory:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to reset skills directory' },
      { status: 500 },
    );
  }
}
