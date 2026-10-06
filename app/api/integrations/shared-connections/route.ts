import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSharedConnection } from '@/app/lib/integration-tools/connections/actions';
import { listSharedIntegrationConnections } from '@/app/lib/integration-tools/connections/store';
import { connectionRequestActor, connectionRequestJson, connectionResponse, connectionResponseError } from './http';

export async function GET(request: Request) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const source = z.enum(['mcp', 'composio']).optional().parse(new URL(request.url).searchParams.get('source') ?? undefined);
    return connectionResponse({ connections: await listSharedIntegrationConnections(actor, source) });
  } catch (error) { return connectionResponseError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return connectionResponse({ connection: await createSharedConnection(actor, await connectionRequestJson(request)) });
  } catch (error) { return connectionResponseError(error); }
}
