import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';
import { AgentAccessError, requireAgentAccessForWorkspace } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { verifyPersonalProvider } from '@/app/lib/agent-runtime-policy/personal-provider-verification';
import { resolveEffectiveAgentRuntime, type AiRuntimeResolutionContext } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import { providerProbeFailureHttpStatus, providerVerificationErrorResponse } from '@/app/lib/agent-runtime-policy/provider-verification-service';

/** Owner-only interactive model test. The request cannot choose a credential subject or execution mode. */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, code: 'UNAUTHORIZED' }, { status: 401 });
  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: `personal-provider-verify:${session.user.id}` });
  if (!limited.ok) return limited.response;
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()
    || typeof payload.agentId !== 'string' || typeof payload.providerInstallationId !== 'string'
    || !/^aip_[a-f0-9]{24}$/u.test(payload.providerInstallationId)
    || (payload.modelId !== undefined && (typeof payload.modelId !== 'string' || !payload.modelId.trim() || payload.modelId.length > 300))
    || Object.keys(payload).some(key => !['workspaceId', 'agentId', 'providerInstallationId', 'modelId'].includes(key))) {
    return NextResponse.json({ success: false, code: 'INVALID_RUNTIME_INPUT', error: 'Provide a workspace, agent and provider installation.' }, { status: 400 });
  }
  try {
    const agentId = normalizeManagedAgentId(payload.agentId);
    const access = await requireSessionWorkspace(session, { workspaceId: payload.workspaceId, permissions: ['canRead', 'canRunAgent'] });
    if (access.response) return access.response;
    if (!access.workspace.organizationId) return NextResponse.json({ success: false, code: 'ORGANIZATION_SETUP_REQUIRED' }, { status: 409 });
    await requireAgentAccessForWorkspace(session.user.id, agentId, 'canUse', access.workspace);
    const context: AiRuntimeResolutionContext = {
      organizationId: access.workspace.organizationId, workspaceId: access.workspace.workspaceId,
      workspaceType: access.workspace.workspaceType, userId: session.user.id, agentId, sessionId: null,
      executionMode: 'interactive', principal: { type: 'user', userId: session.user.id, credentialSubjectUserId: session.user.id },
    };
    const result = await verifyPersonalProvider({ context, providerInstallationId: payload.providerInstallationId, modelId: payload.modelId as string | undefined, signal: request.signal });
    // Return the fresh resolution so the client never selects its stale pre-test provider snapshot.
    const resolution = await resolveEffectiveAgentRuntime(context);
    return NextResponse.json({ success: result.success, code: result.code, data: { result, resolution } },
      { status: result.success ? 200 : providerProbeFailureHttpStatus(result.code) });
  } catch (error) {
    if (error instanceof AgentAccessError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    if (error instanceof Error && error.message === 'INVALID_AGENT_ID') return NextResponse.json({ success: false, code: 'INVALID_AGENT_ID' }, { status: 400 });
    const result = providerVerificationErrorResponse(error);
    return NextResponse.json({ success: false, code: result.code, error: result.message }, { status: result.status });
  }
}
