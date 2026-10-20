import { prepareCapabilityPackageCreatorChatAction, readCapabilityPackageCreatorOptionsAction } from '@/app/lib/capabilities/packages/creator-chat';
import { mobileCapabilityPackageRoute } from '@/app/lib/mobile/capability-package-route-v2';

export const dynamic = 'force-dynamic';
export const GET = mobileCapabilityPackageRoute(async (_request, actor) => ({ ...await readCapabilityPackageCreatorOptionsAction(actor) }));
export const POST = mobileCapabilityPackageRoute(async (_request, actor, _params, body) => ({ ...await prepareCapabilityPackageCreatorChatAction(actor, body) }));
