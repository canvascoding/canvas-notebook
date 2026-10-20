import { inspectCapabilityPackageDraftPresentationAction } from '@/app/lib/capabilities/packages/draft-presentation';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute((request, actor, params) => inspectCapabilityPackageDraftPresentationAction(actor, params.draftRef,
  capabilityPackageQuery(request, ['expectedDraftRevision'])));
