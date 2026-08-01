import { NextResponse } from 'next/server';

import { POST as installPlugin } from '@/app/api/plugins/store/install/route';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { serializeMobileInstalledPlugin } from '@/app/lib/mobile/extensions';

export async function POST(request: Request) {
  const response = await installPlugin(request);
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    error?: string;
    plugin?: CanvasPluginInstallRecord;
  } | null;

  if (!response.ok || !payload?.success || !payload.plugin) {
    return NextResponse.json({
      success: false,
      error: payload?.error || 'Failed to install plugin',
    }, { status: response.status });
  }

  return NextResponse.json({
    success: true,
    plugin: serializeMobileInstalledPlugin(payload.plugin),
  }, {
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
    },
  });
}
