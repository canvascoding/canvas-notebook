import { NextResponse } from 'next/server';
import { authorizeIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { getSharedComposioConnectionStatus } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioRequestActor, sharedComposioResponse, sharedComposioResponseError } from '../../../shared/http';

export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const ref = (await context.params).connectionRef;
    await authorizeIntegrationConnection(actor, ref, 'manage');
    return sharedComposioResponse({ status: await getSharedComposioConnectionStatus(actor, ref) });
  } catch (error) { return sharedComposioResponseError(error); }
}
