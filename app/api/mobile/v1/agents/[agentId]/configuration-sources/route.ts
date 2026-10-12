import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileAgentConfigurationSources } from '@/app/lib/mobile/agent-workflow-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Params = { params: Promise<{ agentId: string }> };

export async function GET(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, ['view', 'expectedRevision', 'expectedWorkflowRevision', 'q', 'page', 'limit', 'kind', 'resourceRef', 'publishedRevisionRef', 'declarationPath', 'capabilityId', 'alternativeKey', 'providerRef']);
    const reference = (await params.params).agentId;
    return await readMobileAgentConfigurationSources(context, request, reference);
  } catch (error) { return mobileScopedError(error); }
}
