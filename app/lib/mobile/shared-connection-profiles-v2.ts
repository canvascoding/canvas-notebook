import 'server-only';
import { z } from 'zod';
import { resolveSharedConnectionOwnership, sharedConnectionOwnershipSchema } from '@/app/lib/integration-tools/connections/actions';
import { createSharedComposioProfile, listSharedComposioProfiles, toPublicSharedComposioProfile } from '@/app/lib/composio/composio-shared-profiles';
import { assertSharedIntegrationOwnershipManagement } from '@/app/lib/integration-tools/connections/ownership';
import { MobileScopedError, mobileScopedJson, mobileScopedResponse, revalidateMobileScopedContext, type MobileScopedContext } from './scoped-route-v2';

export async function readMobileSharedConnectionProfiles(context: MobileScopedContext, request: Request) {
  const query = new URL(request.url).searchParams;
  const type = z.enum(['organization', 'team']).parse(query.get('ownershipType'));
  if (type === 'organization' && query.has('teamWorkspaceId')) throw new MobileScopedError('INVALID_REQUEST', 'Unexpected team selector.');
  await revalidateMobileScopedContext(context);
  const actor = { userId: context.userId, workspaceId: context.workspaceId };
  const ownership = await resolveSharedConnectionOwnership(actor, type === 'team'
    ? { type, workspaceId: query.get('teamWorkspaceId') } : { type });
  const profiles = (await listSharedComposioProfiles(actor, ownership)).map(toPublicSharedComposioProfile);
  const response = await mobileScopedResponse(context, { ownership, profiles });
  await assertSharedIntegrationOwnershipManagement(actor, ownership);
  return response;
}

export async function createMobileSharedConnectionProfile(context: MobileScopedContext, request: Request) {
  const input = z.object({ ownership: sharedConnectionOwnershipSchema, name: z.string().min(1).max(80),
    providerMode: z.enum(['local', 'managed']) }).strict().parse(await mobileScopedJson(request, 16_384));
  await revalidateMobileScopedContext(context);
  const actor = { userId: context.userId, workspaceId: context.workspaceId };
  const ownership = await resolveSharedConnectionOwnership(actor, input.ownership);
  await revalidateMobileScopedContext(context);
  const profile = await createSharedComposioProfile({ actor, ownership, name: input.name, providerMode: input.providerMode });
  const response = await mobileScopedResponse(context, { profile: toPublicSharedComposioProfile(profile) }, 201);
  await assertSharedIntegrationOwnershipManagement(actor, ownership);
  return response;
}
