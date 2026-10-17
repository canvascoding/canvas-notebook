import { inspectCapabilityPackageWorkspaceDraftAction } from '@/app/lib/capabilities/packages/composition';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor) => {
  const parameters = new URL(request.url).searchParams;
  if (parameters.has('workspaceId')) {
    const workspaceId = parameters.get('workspaceId') || '';
    if (parameters.getAll('workspaceId').length !== 1 || !workspaceId.trim() || workspaceId.length > 200) {
      throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The workspace draft query is invalid.');
    }
  }
  return inspectCapabilityPackageWorkspaceDraftAction(actor, capabilityPackageQuery(request, ['kind', 'workspaceDraftId', 'packageName']));
});
