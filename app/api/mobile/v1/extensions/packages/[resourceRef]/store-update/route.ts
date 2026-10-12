import { updateCapabilityPackageFromStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
export const POST = mobileCapabilityPackageRoute((_request, actor, params, body) => updateCapabilityPackageFromStoreAction(actor, params.resourceRef, body));
export const dynamic = 'force-dynamic';
