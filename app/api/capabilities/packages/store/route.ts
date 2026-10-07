import { listCapabilityPackageStoreAction } from '@/app/lib/capabilities/packages/store-actions';
import { capabilityPackageQuery, capabilityPackageRoute } from '../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute((request, actor) => {
  const query = capabilityPackageQuery(request, ['kind', 'q', 'page', 'limit', 'scope', 'audience', 'teamId',
    'installedPage', 'installedLimit', 'installedState']);
  for (const key of ['page', 'limit', 'installedPage', 'installedLimit']) if (key in query) {
    query[key] = /^[1-9]\d*$/u.test(String(query[key])) ? Number(query[key]) : NaN;
  }
  return listCapabilityPackageStoreAction(actor, query);
});
