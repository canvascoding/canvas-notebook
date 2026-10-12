import { inspectCapabilityPackagePresentationAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (_request, actor, params) => ({
  presentation: await inspectCapabilityPackagePresentationAction(actor, params.resourceRef),
}));
