import { inspectCapabilityPackage } from '@/app/lib/capabilities/packages/actions';
import { capabilityPackageRoute } from '../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (_request, actor, params) => ({ package: await inspectCapabilityPackage(actor, params.resourceRef) }));
