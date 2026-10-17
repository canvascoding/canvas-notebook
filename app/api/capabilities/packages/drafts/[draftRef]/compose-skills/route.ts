import { composeCapabilityPackageSkillsAction } from '@/app/lib/capabilities/packages/composition';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { capabilityPackageRoute } from '../../../routes';

export const dynamic = 'force-dynamic';
export const POST = capabilityPackageRoute(async (request, actor, params) => {
  const parsed = await readBoundedJson(request, 256 * 1024);
  if (parsed.response) throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', 'The composition request exceeds its transport limit.', 413);
  if (parsed.body === null) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'A valid JSON request body is required.');
  return composeCapabilityPackageSkillsAction(actor, params.draftRef, parsed.body);
});
