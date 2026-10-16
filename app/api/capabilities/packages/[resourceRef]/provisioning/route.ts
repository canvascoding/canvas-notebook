import { inspectCapabilityPackageProvisioningAction, provisionCapabilityPackageAction } from '@/app/lib/capabilities/packages/provisioning';
import { packageRequestJson } from '../../http';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute((request,actor,params)=>inspectCapabilityPackageProvisioningAction(actor,params.resourceRef,
  capabilityPackageQuery(request,['publishedRevisionRef','checksum'])));
export const POST = capabilityPackageRoute(async(request,actor,params)=>provisionCapabilityPackageAction(actor,params.resourceRef,await packageRequestJson(request)));
