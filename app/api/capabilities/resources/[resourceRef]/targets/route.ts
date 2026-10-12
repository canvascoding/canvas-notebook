import { NextResponse } from 'next/server';
import { listCapabilityResourceTargets } from '@/app/lib/capabilities/resources/actions';
import { resourceRequestActor, resourceResponse, resourceResponseError } from '../../http';

export async function GET(request: Request, context: { params: Promise<{ resourceRef: string }> }) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const { resourceRef } = await context.params;
    return resourceResponse({ targets: await listCapabilityResourceTargets(actor, resourceRef) });
  } catch (error) { return resourceResponseError(error); }
}
