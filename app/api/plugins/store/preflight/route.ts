import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { preflightCanvasPluginFromStore } from '@/app/lib/plugins/canvas-plugin-store';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      name?: unknown;
      version?: unknown;
    };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const preflight = await preflightCanvasPluginFromStore(
      body.name.trim(),
      typeof body.version === 'string' ? body.version.trim() : undefined,
      session.user.id,
      { userId: session.user.id },
    );

    return NextResponse.json({ success: true, preflight });
  } catch (error) {
    console.error('[Plugins Store Preflight API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to check plugin connectors' },
      { status: 500 },
    );
  }
}
