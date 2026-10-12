import { publishCapabilityPackageDraftAction } from '@/app/lib/capabilities/packages/actions';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { packageRequestJson } from '../../../http';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) => {
  const input = await packageRequestJson(request);
  if (!input || typeof input !== 'object' || Reflect.get(input, 'draftRef') !== params.draftRef) {
    throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The selected draft does not match this publication.');
  }
  return publishCapabilityPackageDraftAction(actor, input);
});
