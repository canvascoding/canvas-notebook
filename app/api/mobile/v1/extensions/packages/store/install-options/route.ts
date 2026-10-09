export const dynamic = 'force-dynamic';
import { inspectCapabilityPackageStoreInstallOptionsAction } from '@/app/lib/capabilities/packages/store-install-options';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
export const POST = mobileCapabilityPackageRoute((_request, actor, _params, body) => inspectCapabilityPackageStoreInstallOptionsAction(actor, body));
