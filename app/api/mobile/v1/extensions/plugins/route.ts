import { NextRequest, NextResponse } from 'next/server';

import { GET as getPlugins } from '@/app/api/plugins/route';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { serializeMobileInstalledPlugin } from '@/app/lib/mobile/extensions';

export async function GET(request: NextRequest) {
  const response = await getPlugins(request);
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    error?: string;
    plugins?: CanvasPluginInstallRecord[];
    scope?: string;
  } | null;

  if (!response.ok || !payload?.success || !Array.isArray(payload.plugins)) {
    return NextResponse.json({
      success: false,
      error: payload?.error || 'Failed to load installed plugins',
    }, { status: response.status });
  }

  const plugins = payload.plugins.map(serializeMobileInstalledPlugin);
  return NextResponse.json({
    success: true,
    plugins,
    stats: {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.state.enabled).length,
      disabled: plugins.filter((plugin) => !plugin.state.enabled).length,
    },
    scope: payload.scope,
  }, {
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
    },
  });
}
