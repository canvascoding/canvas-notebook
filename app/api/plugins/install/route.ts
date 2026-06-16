import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { installCanvasPluginFromPath } from '@/app/lib/plugins/canvas-plugin-registry';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      sourcePath?: unknown;
      enable?: unknown;
      replace?: unknown;
    };

    if (typeof body.sourcePath !== 'string' || body.sourcePath.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'sourcePath is required' },
        { status: 400 },
      );
    }

    const result = await installCanvasPluginFromPath(body.sourcePath, {
      enable: body.enable !== false,
      replace: body.replace === true,
      installedBy: session.user.email || session.user.id,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: result.validation?.valid === false ? 400 : 409 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Plugins Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to install plugin' },
      { status: 500 },
    );
  }
}
