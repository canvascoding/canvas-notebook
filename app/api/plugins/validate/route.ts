import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { validateCanvasPluginPackage } from '@/app/lib/plugins/canvas-plugin-manifest';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as { sourcePath?: unknown };
    if (typeof body.sourcePath !== 'string' || body.sourcePath.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'sourcePath is required' },
        { status: 400 },
      );
    }

    const validation = await validateCanvasPluginPackage(body.sourcePath);
    return NextResponse.json({
      success: validation.valid,
      validation,
    }, { status: validation.valid ? 200 : 400 });
  } catch (error) {
    console.error('[Plugins Validate API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to validate plugin' },
      { status: 500 },
    );
  }
}
