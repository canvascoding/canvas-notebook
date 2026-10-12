import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { managementErrorDetails, type AgentManagementActor } from '@/app/lib/agents/management-actions';
import { inspectManagedAgentWorkflow, listManagedAgentWorkflowOptions, setManagedAgentWorkflowChoice } from '@/app/lib/agents/workflow-configuration';
import { agentWorkflowPersonalOptionsSchema, bindOwnAgentWorkflowChoiceInput, updateAgentWorkflowChoiceSchema } from '@/app/lib/agents/workflow-api-contracts';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { agentWorkflowManagementRequestSchema } from '@/app/lib/agents/workflow-management-contracts';
import { listAgentWorkflowManagementOptions } from '@/app/lib/agents/workflow-management';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function actor(request: NextRequest, userId: string, sessionId: string): AgentManagementActor {
  return { userId, sessionId, source: 'api', organizationId: request.nextUrl.searchParams.get('organizationId') || null,
    workspaceId: request.nextUrl.searchParams.get('workspaceId') || null, projectId: request.nextUrl.searchParams.get('projectId') || null };
}
function failure(error: unknown): NextResponse {
  const details = managementErrorDetails(error);
  return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status });
}
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'agent-workflow-get' });
  if (!limited.ok) return limited.response;
  try {
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (!agentId) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'An exact agent is required.', 400);
    const currentActor = actor(request, session.user.id, session.session.id);
    const view = request.nextUrl.searchParams.get('view');
    if (view && ['management', 'packages', 'package-version', 'connections', 'personal-connections', 'personal-mcp-definitions'].includes(view)) {
      const params = request.nextUrl.searchParams;
      const raw: Record<string, unknown> = {};
      for (const [key, value] of params) {
        if (['organizationId', 'workspaceId', 'projectId'].includes(key)) continue;
        if (Object.hasOwn(raw, key)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate configuration selectors are not supported.', 400);
        raw[key] = ['expectedRevision', 'expectedWorkflowRevision', 'page', 'limit'].includes(key) ? Number(value) : value;
      }
      const parsed = agentWorkflowManagementRequestSchema.safeParse(raw);
      if (!parsed.success) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Choose an exact workflow configuration and permitted published version.', 400);
      const data = await listAgentWorkflowManagementOptions(currentActor, parsed.data);
      return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (view === 'personal-options') {
      const params = request.nextUrl.searchParams, rawRevision = params.get('expectedWorkflowRevision');
      const parsed = agentWorkflowPersonalOptionsSchema.safeParse({ agentId, capabilityKey: params.get('capabilityKey'),
        alternativeKey: params.get('alternativeKey') ?? undefined, providerRef: params.get('providerRef') ?? undefined,
        expectedWorkflowRevision: rawRevision === null ? undefined : Number(rawRevision) });
      if (!parsed.success) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Choose a permitted workflow capability and connection.', 400);
      const { listAgentWorkflowPersonalOptions } = await import('@/app/lib/agents/workflow-personal-options');
      return NextResponse.json({ success: true, data: await listAgentWorkflowPersonalOptions(currentActor, parsed.data) });
    }
    const data = view === 'options'
      ? await listManagedAgentWorkflowOptions(currentActor, agentId) : await inspectManagedAgentWorkflow(currentActor, agentId);
    return NextResponse.json({ success: true, data });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agent-workflow-choice-patch' });
  if (!limited.ok) return limited.response;
  try {
    const parsed = updateAgentWorkflowChoiceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AgentWorkflowError('AGENT_WORKFLOW_CHOICE_INVALID', 'The selection contains invalid or unsupported fields.', 400);
    const data = await setManagedAgentWorkflowChoice({ ...bindOwnAgentWorkflowChoiceInput(parsed.data, session.user.id),
      actor: actor(request, session.user.id, session.session.id) });
    return NextResponse.json({ success: true, data });
  } catch (error) { return failure(error); }
}
