import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readCanvasPluginStoreIcon } from '@/app/lib/plugins/canvas-plugin-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'mobile-plugin-store-icon',
  });
  if (!limited.ok) return limited.response;

  try {
    const { name } = await context.params;
    const icon = await readCanvasPluginStoreIcon(decodeURIComponent(name));
    if (!icon) {
      return NextResponse.json({ success: false, error: 'Plugin icon not found' }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(icon.bytes), {
      headers: {
        'Cache-Control': 'private, max-age=86400',
        'Content-Type': icon.contentType,
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    console.error('[Mobile Plugin Store Icon API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load plugin icon' }, { status: 500 });
  }
}
