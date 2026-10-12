import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedJson, mobileScopedResponse, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { mobileSharedOAuthActionSchema } from '@/app/lib/mobile/shared-connection-oauth-contracts';
import { readMobileSharedConnectionOAuth, decideMobileSharedConnectionOAuth } from '@/app/lib/mobile/shared-connection-oauth';

export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ connectionRef: string; flowId: string }> };
export async function GET(request: NextRequest, route: Route) {
  try {
    const context = await requireMobileScopedContext(request), { connectionRef, flowId } = await route.params;
    return await mobileScopedResponse(context, await readMobileSharedConnectionOAuth(context, connectionRef, flowId));
  } catch (error) { return mobileScopedError(error); }
}
export async function POST(request: NextRequest, route: Route) {
  try {
    const context = await requireMobileScopedContext(request), input = mobileSharedOAuthActionSchema.parse(await mobileScopedJson(request, 16 * 1024));
    const { connectionRef, flowId } = await route.params;
    return await mobileScopedResponse(context, await decideMobileSharedConnectionOAuth(context, connectionRef, flowId, input.action));
  } catch (error) { return mobileScopedError(error); }
}
