import { NextResponse } from 'next/server';
import { getSharedComposioConnectionStatus } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioRequestActor, sharedComposioResponse, sharedComposioResponseError } from '../../../shared/http';

export async function GET(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return sharedComposioResponse({ status: await getSharedComposioConnectionStatus(actor, (await context.params).connectionRef) });
  } catch (error) { return sharedComposioResponseError(error); }
}
