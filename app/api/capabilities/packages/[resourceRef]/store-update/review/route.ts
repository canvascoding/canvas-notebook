import { inspectCapabilityPackageStoreUpdateAction } from '@/app/lib/capabilities/packages/store-actions';
import { packageRequestJson } from '../../../http';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) =>
  inspectCapabilityPackageStoreUpdateAction(actor, params.resourceRef, await packageRequestJson(request)));
