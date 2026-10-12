import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileSharedConnectionProfiles, createMobileSharedConnectionProfile } from '@/app/lib/mobile/shared-connection-profiles-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, ['ownershipType', 'teamWorkspaceId']);
    return await readMobileSharedConnectionProfiles(context, request);
  } catch (error) { return mobileScopedError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request);
    return await createMobileSharedConnectionProfile(context, request);
  } catch (error) { return mobileScopedError(error); }
}
