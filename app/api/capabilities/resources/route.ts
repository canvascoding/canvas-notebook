import { NextResponse } from 'next/server';
import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { resourceRequestActor, resourceResponse, resourceResponseError } from './http';

export async function GET(request: Request) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return resourceResponse({ resources: await listCapabilityResources(actor) });
  } catch (error) { return resourceResponseError(error); }
}
