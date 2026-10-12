import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileAgentWorkflow,chooseMobileAgentWorkflow,configureMobileAgentWorkflow } from '@/app/lib/mobile/agent-workflow-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Params = { params: Promise<{ agentId: string }> };

export async function GET(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, ['view', 'capabilityKey', 'alternativeKey', 'providerRef', 'expectedWorkflowRevision']);
    const reference = (await params.params).agentId;
    return await readMobileAgentWorkflow(context, request, reference);
  } catch (error) { return mobileScopedError(error); }
}

export async function POST(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).agentId;
    return await chooseMobileAgentWorkflow(context, request, reference);
  } catch (error) { return mobileScopedError(error); }
}

export async function PATCH(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).agentId;
    return await configureMobileAgentWorkflow(context, request, reference);
  } catch (error) { return mobileScopedError(error); }
}
