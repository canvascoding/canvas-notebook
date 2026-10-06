import { NextResponse } from 'next/server';
import { z } from 'zod';
import { disconnectSharedComposioConnection } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioExpectedRevisions } from '@/app/lib/composio/composio-shared-account-reference';
import { sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError, sharedComposioRevisionSchema } from '../../../shared/http';

export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object(sharedComposioRevisionSchema).strict().parse(await sharedComposioRequestJson(request));
    return sharedComposioResponse({ connection: await disconnectSharedComposioConnection(actor, (await context.params).connectionRef, sharedComposioExpectedRevisions(input)) });
  } catch (error) { return sharedComposioResponseError(error); }
}
