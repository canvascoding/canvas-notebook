import { NextResponse } from 'next/server';
import { listSharedIntegrationConnectionTargets } from '@/app/lib/integration-tools/connections/store';
import { connectionRequestActor, connectionResponse, connectionResponseError } from '../../http';

export async function GET(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return connectionResponse({ targets: await listSharedIntegrationConnectionTargets(actor, (await context.params).connectionRef) });
  } catch (error) { return connectionResponseError(error); }
}
