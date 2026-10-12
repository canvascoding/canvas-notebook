import { validateCapabilityPackageDraftAction } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (_request, actor, params) => validateCapabilityPackageDraftAction(actor, params.draftRef));
