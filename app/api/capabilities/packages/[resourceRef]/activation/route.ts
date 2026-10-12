import { setCapabilityPackageDefaultActivationAction } from '@/app/lib/capabilities/packages/activation';
import { packageRequestJson } from '../../http';
import { capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const PATCH = capabilityPackageRoute(async (request, actor, params) => setCapabilityPackageDefaultActivationAction(actor, params.resourceRef,
  await packageRequestJson(request)));
