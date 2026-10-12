import { NextResponse } from 'next/server';
import { z } from 'zod';
import { bindSharedComposioConnectionAccount, listSharedComposioConnectionAccounts } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioExpectedRevisions } from '@/app/lib/composio/composio-shared-account-reference';
import { sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError, sharedComposioRevisionSchema } from '../../../shared/http';

type Context = { params: Promise<{ connectionRef: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return sharedComposioResponse(await listSharedComposioConnectionAccounts(actor, (await context.params).connectionRef));
  } catch (error) { return sharedComposioResponseError(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object({ ...sharedComposioRevisionSchema, accountRef: z.string().min(1).max(8192) }).strict().parse(await sharedComposioRequestJson(request));
    return sharedComposioResponse({ connection: await bindSharedComposioConnectionAccount(actor, (await context.params).connectionRef,
      { accountRef: input.accountRef, revisions: sharedComposioExpectedRevisions(input) }) });
  } catch (error) { return sharedComposioResponseError(error); }
}
