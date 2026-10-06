import { NextResponse } from 'next/server';
import { resolveSharedConnectionOwnership } from '@/app/lib/integration-tools/connections/actions';
import { listManageableSharedIntegrationScopes, listSharedIntegrationSetupTargets } from '@/app/lib/integration-tools/connections/store';
import { connectionRequestActor, connectionResponse, connectionResponseError } from '../http';

export async function GET(request: Request) {
  try {
    const actor = await connectionRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const query = new URL(request.url).searchParams;
    if (!query.has('ownershipType')) return connectionResponse({ scopes: await listManageableSharedIntegrationScopes(actor) });
    const owner = await resolveSharedConnectionOwnership(actor, query.get('ownershipType') === 'team'
      ? { type: 'team', workspaceId: query.get('teamWorkspaceId') } : { type: query.get('ownershipType') });
    return connectionResponse({ targets: await listSharedIntegrationSetupTargets(actor, owner) });
  } catch (error) { return connectionResponseError(error); }
}
