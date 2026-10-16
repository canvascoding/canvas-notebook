import { addCapabilityPackageDraftRequirementAction } from '@/app/lib/capabilities/packages/authoring-catalog';
import { packageRequestJson } from '../../../http';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) => addCapabilityPackageDraftRequirementAction(actor, params.draftRef,
  await packageRequestJson(request)));
