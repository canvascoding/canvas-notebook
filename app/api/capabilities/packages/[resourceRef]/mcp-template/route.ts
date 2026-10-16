import { inspectCapabilityPackageMcpTemplateAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor, params) => ({
  template: await inspectCapabilityPackageMcpTemplateAction(actor, params.resourceRef,
    capabilityPackageQuery(request, ['connector', 'expectedChecksum'])),
}));
