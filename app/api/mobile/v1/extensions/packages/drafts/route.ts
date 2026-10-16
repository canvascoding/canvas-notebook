import { listCapabilityPackageOwnedDraftStatusesAction } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageOwnedDraftListQuerySchema } from '@/app/lib/capabilities/packages/schemas';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';

export const dynamic = 'force-dynamic';
export const GET = mobileCapabilityPackageRoute(async (request, actor) => {
  const parameters = new URL(request.url).searchParams;
  return listCapabilityPackageOwnedDraftStatusesAction(actor, capabilityPackageOwnedDraftListQuerySchema.parse({
    ...(parameters.has('limit') ? {limit: /^[1-9]\d?$/u.test(parameters.get('limit')!) ? Number(parameters.get('limit')) : NaN} : {}),
    ...(parameters.has('cursor') ? {cursor: parameters.get('cursor')} : {}),
  }));
}, ['limit', 'cursor']);
