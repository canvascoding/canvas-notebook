import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { restoreCanvasSkill } from '@/app/lib/skills/canvas-skill-store';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name } = await params;
    const body = await request.json().catch(() => ({})) as {
      prefer?: unknown;
      version?: unknown;
      enable?: unknown;
    };
    const prefer = body.prefer === 'seed' || body.prefer === 'store' ? body.prefer : undefined;
    const result = await restoreCanvasSkill(name, {
      prefer,
      version: typeof body.version === 'string' ? body.version.trim() : undefined,
      enable: body.enable !== false,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills Restore API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to restore skill' },
      { status: 500 },
    );
  }
}
