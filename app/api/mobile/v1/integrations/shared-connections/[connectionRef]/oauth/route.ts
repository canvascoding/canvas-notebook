import { NextRequest } from 'next/server';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { requireMobileScopedContext, mobileScopedJson, mobileScopedResponse, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { mobileSharedOAuthStartSchema } from '@/app/lib/mobile/shared-connection-oauth-contracts';
import { startMobileSharedConnectionOAuth } from '@/app/lib/mobile/shared-connection-oauth';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest, route: { params: Promise<{ connectionRef: string }> }) {
  try {
    const context = await requireMobileScopedContext(request), input = mobileSharedOAuthStartSchema.parse(await mobileScopedJson(request, 16 * 1024));
    return await mobileScopedResponse(context, await startMobileSharedConnectionOAuth(context, (await route.params).connectionRef, input, getPublicRequestOrigin(request)));
  } catch (error) { return mobileScopedError(error); }
}
