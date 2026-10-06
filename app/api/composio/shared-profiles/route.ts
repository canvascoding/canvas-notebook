import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSharedComposioProfile, listSharedComposioProfiles, toPublicSharedComposioProfile } from '@/app/lib/composio/composio-shared-profiles';
import { sharedComposioOwnershipSchema, sharedComposioRequestActor, sharedComposioRequestJson, sharedComposioRequestOwnership,
  sharedComposioResponse, sharedComposioResponseError } from '../shared/http';

export async function GET(request: Request) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const query = new URL(request.url).searchParams;
    const choice = sharedComposioOwnershipSchema.parse(query.get('ownershipType') === 'team'
      ? { type: 'team', workspaceId: query.get('teamWorkspaceId') } : { type: query.get('ownershipType') });
    const ownership = await sharedComposioRequestOwnership(actor, choice);
    return sharedComposioResponse({ profiles: (await listSharedComposioProfiles(actor, ownership)).map(toPublicSharedComposioProfile) });
  } catch (error) { return sharedComposioResponseError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await sharedComposioRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const input = z.object({ name: z.string().min(1).max(80), ownership: sharedComposioOwnershipSchema, providerMode: z.enum(['local', 'managed']) }).strict().parse(await sharedComposioRequestJson(request));
    const profile = await createSharedComposioProfile({ actor, ownership: await sharedComposioRequestOwnership(actor, input.ownership), name: input.name, providerMode: input.providerMode });
    return sharedComposioResponse({ profile: toPublicSharedComposioProfile(profile) });
  } catch (error) { return sharedComposioResponseError(error); }
}
