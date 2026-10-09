import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileSharedConnectionSetup } from '@/app/lib/mobile/scoped-resources-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, ['ownershipType', 'teamWorkspaceId']);
    return await readMobileSharedConnectionSetup(context, request);
  } catch (error) { return mobileScopedError(error); }
}
