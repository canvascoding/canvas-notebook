import { NextResponse } from 'next/server';
import { z } from 'zod';
import { inspectSharedComposioProfile, mutateSharedComposioProfile, toPublicSharedComposioProfile } from '@/app/lib/composio/composio-shared-profiles';
import { sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioResponse, sharedComposioResponseError } from '../../shared/http';

type Context = { params: Promise<{ profileId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    return sharedComposioResponse({ profile: toPublicSharedComposioProfile(await inspectSharedComposioProfile(actor, (await context.params).profileId)) });
  } catch (error) { return sharedComposioResponseError(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object({ expectedProfileRevision: z.number().int().positive(), name: z.string().min(1).max(80).optional(), status: z.enum(['active', 'archived']).optional() }).strict().parse(await sharedComposioRequestJson(request));
    return sharedComposioResponse({ profile: toPublicSharedComposioProfile(await mutateSharedComposioProfile({ actor, profileId: (await context.params).profileId, ...input })) });
  } catch (error) { return sharedComposioResponseError(error); }
}
