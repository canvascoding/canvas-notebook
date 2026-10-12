export const dynamic = 'force-dynamic';
import { inspectCapabilityPackagePresentationAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
export const GET = mobileCapabilityPackageRoute(async (_request, actor, params) => ({ presentation: await inspectCapabilityPackagePresentationAction(actor, params.resourceRef) }));
