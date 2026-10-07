import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectSharedComposioConnection } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioExpectedRevisions } from '@/app/lib/composio/composio-shared-account-reference';
import { sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError, sharedComposioRevisionSchema } from '../../../shared/http';

export async function POST(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object({ ...sharedComposioRevisionSchema, returnPath: z.string().min(1).max(2048).optional(), returnLocale: z.enum(['de', 'en']).optional() }).strict().parse(await sharedComposioRequestJson(request));
    return sharedComposioResponse(await connectSharedComposioConnection(actor, (await context.params).connectionRef,
      { revisions: sharedComposioExpectedRevisions(input), returnPath: input.returnPath, returnLocale: input.returnLocale }));
  } catch (error) { return sharedComposioResponseError(error); }
}
