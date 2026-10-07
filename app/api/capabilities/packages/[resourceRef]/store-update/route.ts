import { updateCapabilityPackageFromStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) =>
  updateCapabilityPackageFromStoreAction(actor, params.resourceRef, await packageRequestJson(request)));
