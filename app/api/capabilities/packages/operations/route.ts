import { readCapabilityPackageOperationAction } from '@/app/lib/capabilities/packages/actions';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { capabilityPackageQuery, capabilityPackageRoute } from '../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor) => {
  const parameters = new URL(request.url).searchParams;
  if (parameters.has('workspaceId')) {
    const workspaceId = parameters.get('workspaceId') || '';
    if (parameters.getAll('workspaceId').length !== 1 || !workspaceId.trim() || workspaceId.length > 200) {
      throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The operation status query is invalid.');
    }
  }
  return readCapabilityPackageOperationAction(actor, capabilityPackageQuery(request, ['requestId', 'draftRef']));
});
