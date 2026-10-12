import { NextResponse } from 'next/server';
import { updateSharedConnection } from '@/app/lib/integration-tools/connections/actions';
import { inspectSharedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { connectionRequestActor, connectionRequestJson, connectionResponse, connectionResponseError } from '../http';
type Context = { params: Promise<{ connectionRef: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return connectionResponse({ connection: await inspectSharedIntegrationConnection(actor, (await context.params).connectionRef) });
  } catch (error) { return connectionResponseError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return connectionResponse({ connection: await updateSharedConnection(actor, (await context.params).connectionRef, await connectionRequestJson(request)) });
  } catch (error) { return connectionResponseError(error); }
}
