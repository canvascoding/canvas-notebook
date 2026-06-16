import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { setCanvasPluginEnabled } from '@/app/lib/plugins/canvas-plugin-registry';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  const result = await setCanvasPluginEnabled(name, true);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error?.includes('not found') ? 404 : 400 },
    );
  }

  return NextResponse.json({ success: true, plugin: result.plugin });
}
