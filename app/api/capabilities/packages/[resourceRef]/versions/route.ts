import { listCapabilityPackageVersionsAction } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (_request, actor, params) => listCapabilityPackageVersionsAction(actor, params.resourceRef));
