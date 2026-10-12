import { NextResponse } from 'next/server';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { listPluginWorkspaceCatalog, parsePluginWorkspaceCatalogQuery } from '@/app/lib/plugins/plugin-workspace-catalog';
import { resourceRequestActor, resourceResponse, resourceResponseError } from '@/app/api/capabilities/resources/http';

export async function GET(request: Request) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const parameters = new URL(request.url).searchParams;
    const query = parsePluginWorkspaceCatalogQuery(parameters);
    const headerWorkspace = request.headers.get(WORKSPACE_ID_HEADER)?.trim();
    const queryWorkspace = parameters.get('workspaceId');
    if (headerWorkspace && queryWorkspace && headerWorkspace !== queryWorkspace) {
      throw new CapabilityResourceError('PLUGIN_CATALOG_QUERY_INVALID', 'Conflicting workspace selections are not supported.', 400);
    }
    return resourceResponse(await listPluginWorkspaceCatalog(actor, query));
  } catch (error) { return resourceResponseError(error); }
}
