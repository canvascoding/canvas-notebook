import { installCapabilityPackageFromStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor) =>
  installCapabilityPackageFromStoreAction(actor, await packageRequestJson(request)));
