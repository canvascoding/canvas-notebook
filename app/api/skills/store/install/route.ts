import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { installCanvasSkillFromStore } from '@/app/lib/skills/canvas-skill-store';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      name?: unknown;
      version?: unknown;
      enable?: unknown;
      replace?: unknown;
    };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const result = await installCanvasSkillFromStore(
      body.name.trim(),
      typeof body.version === 'string' ? body.version.trim() : undefined,
      {
        enable: body.enable !== false,
        replace: body.replace !== false,
      },
    );

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills Store Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to install skill' },
      { status: 500 },
    );
  }
}
