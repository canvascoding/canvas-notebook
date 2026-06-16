import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { listCanvasPlugins } from '@/app/lib/plugins/canvas-plugin-registry';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const plugins = await listCanvasPlugins();
    return NextResponse.json({
      success: true,
      plugins,
      stats: {
        total: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        disabled: plugins.filter((plugin) => !plugin.enabled).length,
      },
    });
  } catch (error) {
    console.error('[Plugins API] Error loading plugins:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugins' },
      { status: 500 },
    );
  }
}
