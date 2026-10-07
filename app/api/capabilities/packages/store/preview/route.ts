import { inspectCapabilityPackageStoreOfferingAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor) => ({
  presentation: await inspectCapabilityPackageStoreOfferingAction(actor, await packageRequestJson(request)),
}));
