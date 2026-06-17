import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listCanvasPluginStore } from '@/app/lib/plugins/canvas-plugin-store';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = await listCanvasPluginStore();
    return NextResponse.json({
      success: true,
      ...store,
      stats: {
        total: store.plugins.length,
        installed: store.plugins.filter((plugin) => plugin.installed.installed).length,
        updates: store.plugins.filter((plugin) => plugin.installed.updateAvailable).length,
      },
    });
  } catch (error) {
    console.error('[Plugins Store API] Error loading store:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugin store' },
      { status: 500 },
    );
  }
}
