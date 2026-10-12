import { installCapabilityPackageFromStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
export const POST = mobileCapabilityPackageRoute((_request, actor, _params, body) => installCapabilityPackageFromStoreAction(actor, body));
export const dynamic = 'force-dynamic';
