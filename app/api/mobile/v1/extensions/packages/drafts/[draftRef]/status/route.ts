import { readCapabilityPackageOwnedDraftStatusAction } from '@/app/lib/capabilities/packages/actions';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';

export const dynamic = 'force-dynamic';
export const GET = mobileCapabilityPackageRoute(async (_request, actor, params) => readCapabilityPackageOwnedDraftStatusAction(actor, params.draftRef));
