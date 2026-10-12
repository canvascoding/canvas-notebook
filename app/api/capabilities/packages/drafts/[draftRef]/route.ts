import { discardCapabilityPackageDraftAction, readCapabilityPackageDraftAction } from '@/app/lib/capabilities/packages/actions';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (_request, actor, params) => readCapabilityPackageDraftAction(actor, params.draftRef));
export const DELETE = capabilityPackageRoute(async (request, actor, params) => discardCapabilityPackageDraftAction(actor, params.draftRef, await packageRequestJson(request)));
