import { inspectCapabilityPackageDraftPresentationAction, capabilityPackageDraftPresentationQuerySchema } from '@/app/lib/capabilities/packages/draft-presentation';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';

export const dynamic = 'force-dynamic';
export const GET = mobileCapabilityPackageRoute(async (request, actor, params) => {
  const revision = new URL(request.url).searchParams.get('expectedDraftRevision');
  return inspectCapabilityPackageDraftPresentationAction(actor, params.draftRef,
    capabilityPackageDraftPresentationQuerySchema.parse(revision === null ? {} : {expectedDraftRevision: revision}));
}, ['expectedDraftRevision']);
