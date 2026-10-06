import { createCapabilityPackageDraftAction } from '@/app/lib/capabilities/packages/actions';
import { packageRequestJson } from '../http';
import { capabilityPackageRoute } from '../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor) => ({ draft: await createCapabilityPackageDraftAction(actor, await packageRequestJson(request)) }));
