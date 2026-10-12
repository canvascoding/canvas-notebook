import { listCapabilityPackageDraftFilesAction } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (_request, actor, params) => listCapabilityPackageDraftFilesAction(actor, params.draftRef));
