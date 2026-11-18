/**
 * Studio reference assets listing API
 * Lists available media files from studio outputs, studio asset references, and user uploads
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { listStudioReferenceAssets, type AssetKind } from '@/app/lib/integrations/studio-reference-assets';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  const scope = studioRequest.scope;

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'studio-references',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    const kindParam = (searchParams.get('kind') || 'image').trim().toLowerCase();
    const requestedKind: AssetKind = kindParam === 'video' || kindParam === 'audio' ? kindParam : 'image';
    const veoOnly = searchParams.get('veoOnly') === 'true';
    const limitRaw = Number(searchParams.get('limit') || '300');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 300;
    const depthRaw = Number(searchParams.get('depth') || '8');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 12)) : 8;
    return NextResponse.json(await listStudioReferenceAssets(scope, { requestedKind, query, limit, depth, veoOnly }));
  } catch (error) {
    console.error('[API] studio/references/assets error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load studio reference assets';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
