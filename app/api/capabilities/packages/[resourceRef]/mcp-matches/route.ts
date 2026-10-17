import { inspectCapabilityPackageMcpMatches } from '@/app/lib/capabilities/packages/mcp-template-matches';
import { capabilityPackageQuery, capabilityPackageRoute } from '../../routes';

export const dynamic = 'force-dynamic';
export const GET = capabilityPackageRoute(async (request, actor, params) =>
  inspectCapabilityPackageMcpMatches(actor, params.resourceRef, capabilityPackageQuery(request, ['connector', 'expectedChecksum'])));
