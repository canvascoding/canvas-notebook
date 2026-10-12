import { inspectCapabilityPackageStoreInstallOptionsAction } from '@/app/lib/capabilities/packages/store-install-options';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor) =>
  inspectCapabilityPackageStoreInstallOptionsAction(actor, await packageRequestJson(request)));
