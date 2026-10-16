import { importCapabilityPackageWorkspaceDraftAction } from '@/app/lib/capabilities/packages/composition';
import { packageRequestJson } from '../../../http';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) =>
  importCapabilityPackageWorkspaceDraftAction(actor, params.draftRef, await packageRequestJson(request)));
