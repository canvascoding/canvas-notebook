import { NextResponse } from 'next/server';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { parsePluginExtensionQuery } from '@/app/lib/plugins/plugin-extension-search';
import { searchPluginExtensionAuthoringMetadata } from '@/app/lib/plugins/plugin-extension-authoring-search';
import { resourceRequestActor, resourceResponse, resourceResponseError } from '@/app/api/capabilities/resources/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const parameters = new URL(request.url).searchParams, query = parsePluginExtensionQuery(parameters);
    const headerWorkspace = request.headers.get(WORKSPACE_ID_HEADER)?.trim(), requestedWorkspace = parameters.get('workspaceId');
    if (headerWorkspace && requestedWorkspace && headerWorkspace !== requestedWorkspace) {
      throw new CapabilityResourceError('PLUGIN_SEARCH_QUERY_INVALID', 'Conflicting workspace selections are not supported.', 400);
    }
    return resourceResponse(await searchPluginExtensionAuthoringMetadata(actor, query, { signal: request.signal }));
  } catch (error) { return resourceResponseError(error); }
}
