import { listCapabilityPackageStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { capabilityPackageQuery } from '@/app/api/capabilities/packages/routes';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';
const fields = ['kind', 'q', 'page', 'limit', 'scope', 'audience', 'teamId', 'installedPage', 'installedLimit', 'installedState'] as const;
export const GET = mobileCapabilityPackageRoute((request, actor) => {
  const query = capabilityPackageQuery(request, fields);
  for (const key of ['page', 'limit', 'installedPage', 'installedLimit']) if (key in query) {
    query[key] = /^[1-9]\d*$/u.test(String(query[key])) ? Number(query[key]) : NaN;
  }
  return listCapabilityPackageStoreAction(actor, query);
}, fields);
export const dynamic = 'force-dynamic';
