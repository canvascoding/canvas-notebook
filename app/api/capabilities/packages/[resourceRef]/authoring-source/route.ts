import { inspectCapabilityPackageAuthoringSourceAction } from '@/app/lib/capabilities/packages/authoring-catalog';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute((request, actor, params) => inspectCapabilityPackageAuthoringSourceAction(actor, params.resourceRef,
  capabilityPackageQuery(request, ['revisionRef'])));
