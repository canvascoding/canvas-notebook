export const dynamic = 'force-dynamic';
import { inspectCapabilityPackageStoreOfferingAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
export const POST = mobileCapabilityPackageRoute(async (_request, actor, _params, body) => ({ presentation: await inspectCapabilityPackageStoreOfferingAction(actor, body) }));
