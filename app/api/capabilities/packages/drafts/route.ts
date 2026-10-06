import { createCapabilityPackageDraftAction, listCapabilityPackageOwnedDraftStatusesAction } from '@/app/lib/capabilities/packages/actions';
import { CapabilityPackageError, type CapabilityPackageOwnedDraftListQuery } from '@/app/lib/capabilities/packages/contracts';
import { packageRequestJson } from '../http';
import { capabilityPackageRoute } from '../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor) => {
  const parameters = new URL(request.url).searchParams, query: CapabilityPackageOwnedDraftListQuery = {};
  for (const [name, value] of parameters) {
    if (!['limit', 'cursor', 'workspaceId'].includes(name) || parameters.getAll(name).length !== 1) {
      throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The draft list query is invalid.');
    }
    if (name === 'workspaceId') {
      if (!value.trim() || value.length > 200) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The draft list query is invalid.');
    } else if (name === 'limit') {
      if (!/^[1-9]\d?$/u.test(value)) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The draft list query is invalid.');
      query.limit = Number(value);
    } else query.cursor = value;
  }
  return listCapabilityPackageOwnedDraftStatusesAction(actor, query);
});
export const POST = capabilityPackageRoute(async (request, actor) => ({ draft: await createCapabilityPackageDraftAction(actor, await packageRequestJson(request)) }));
