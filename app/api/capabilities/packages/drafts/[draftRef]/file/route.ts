import { deleteCapabilityPackageDraftFileAction, readCapabilityPackageDraftFileAction, writeCapabilityPackageDraftFileAction } from '@/app/lib/capabilities/packages/actions';
import { packageRequestJson } from '../../../http';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor, params) => readCapabilityPackageDraftFileAction(actor, params.draftRef,
  capabilityPackageQuery(request, ['path', 'offset', 'maxBytes'])));
export const PUT = capabilityPackageRoute(async (request, actor, params) => writeCapabilityPackageDraftFileAction(actor, params.draftRef, await packageRequestJson(request, true)));
export const DELETE = capabilityPackageRoute(async (request, actor, params) => deleteCapabilityPackageDraftFileAction(actor, params.draftRef, await packageRequestJson(request)));
