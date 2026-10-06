import { readCapabilityPackageFileAction } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor, params) => readCapabilityPackageFileAction(actor, params.resourceRef,
  capabilityPackageQuery(request, ['revisionRef', 'path', 'offset', 'maxBytes'])));
