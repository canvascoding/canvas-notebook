import { NextResponse } from 'next/server';
import { z } from 'zod';
import { disconnectSharedMcpOAuth, readSharedMcpOAuthState, startSharedMcpOAuth } from '@/app/lib/mcp/shared-oauth';
import { inspectSharedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { sharedMcpRequestActor, sharedMcpRequestJson, sharedMcpResponse, sharedMcpResponseError, sharedMcpRevisionSchema, sharedMcpRevisions } from '../../http';

export async function GET(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    return sharedMcpResponse(await readSharedMcpOAuthState(actor, (await context.params).connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = z.object(sharedMcpRevisionSchema).strict().parse(await sharedMcpRequestJson(request));
    return sharedMcpResponse(await startSharedMcpOAuth(actor, (await context.params).connectionRef, sharedMcpRevisions(input), new URL(request.url).origin));
  } catch (error) { return sharedMcpResponseError(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = z.object(sharedMcpRevisionSchema).strict().parse(await sharedMcpRequestJson(request));
    const record = await disconnectSharedMcpOAuth(actor, (await context.params).connectionRef, sharedMcpRevisions(input));
    return sharedMcpResponse(await inspectSharedIntegrationConnection(actor, record.resource.connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
