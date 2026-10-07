import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { disconnectSharedMcpOAuth, readSharedMcpOAuthState, startSharedMcpOAuth } from '@/app/lib/mcp/shared-oauth';
import { inspectSharedIntegrationConnection, validateIntegrationConnectionRef } from '@/app/lib/integration-tools/connections/store';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { sharedMcpRequestActor, sharedMcpRequestDesktopInitiator, sharedMcpRequestJson, sharedMcpResponse, sharedMcpResponseError, sharedMcpRevisionSchema, sharedMcpRevisions } from '../../http';

export async function GET(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    return sharedMcpResponse(await readSharedMcpOAuthState(actor, (await context.params).connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const input = z.object({ ...sharedMcpRevisionSchema, returnLocale: z.enum(['de', 'en']).optional(), desktop: z.boolean().optional() })
      .strict().parse(await sharedMcpRequestJson(request));
    if (input.desktop === true) {
      const initiator = await sharedMcpRequestDesktopInitiator(request); if (initiator instanceof NextResponse) return initiator;
      const limited = rateLimit(new NextRequest(request.url, { headers: request.headers }), {
        limit: 30, windowMs: 60_000, keyPrefix: 'mcp-shared-desktop-oauth-start', verifiedUserId: initiator.actor.userId,
      });
      if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
      const connectionRef = validateIntegrationConnectionRef((await context.params).connectionRef);
      const result = await startSharedMcpOAuth(initiator.actor, connectionRef, sharedMcpRevisions(input), new URL(request.url).origin,
        { returnLocale: input.returnLocale, desktop: { authSessionId: initiator.authSessionId } });
      return sharedMcpResponse({ ...result, connectionRef });
    }
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    return sharedMcpResponse(await startSharedMcpOAuth(actor, (await context.params).connectionRef, sharedMcpRevisions(input), new URL(request.url).origin,
      { returnLocale: input.returnLocale }));
  } catch (error) {
    const response = sharedMcpResponseError(error); response.headers.set('Cache-Control', 'no-store'); return response;
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = z.object(sharedMcpRevisionSchema).strict().parse(await sharedMcpRequestJson(request));
    const record = await disconnectSharedMcpOAuth(actor, (await context.params).connectionRef, sharedMcpRevisions(input));
    return sharedMcpResponse(await inspectSharedIntegrationConnection(actor, record.resource.connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
