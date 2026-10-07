import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createManagedAgent,
  deleteManagedAgent,
  inspectManagedAgent,
  listManagedAgents,
  managementErrorDetails,
  type AgentManagementActor,
  type CreateManagedAgentInput,
} from '@/app/lib/agents/management-actions';
import { updateManagedAgentConfiguration } from '@/app/lib/agents/workflow-configuration';
import { updateAgentConfigurationSchema } from '@/app/lib/agents/workflow-api-contracts';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function actorFromRequest(request: NextRequest, session: AuthSession): AgentManagementActor {
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    source: 'api',
    organizationId: request.nextUrl.searchParams.get('organizationId')?.trim() || null,
    workspaceId: request.nextUrl.searchParams.get('workspaceId')?.trim() || null,
    projectId: request.nextUrl.searchParams.get('projectId')?.trim() || null,
  };
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  const details = managementErrorDetails(error);
  return NextResponse.json(
    {
      success: false,
      code: details.code,
      error: details.message || fallback,
      ...(details.details || {}),
    },
    { status: details.status },
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hasAny(payload: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => Object.hasOwn(payload, field));
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'agents-list-get' });
  if (!limited.ok) return limited.response;

  try {
    const purpose = request.nextUrl.searchParams.get('purpose') ?? 'use';
    if (request.nextUrl.searchParams.getAll('purpose').length > 1 || !['use', 'configure'].includes(purpose)
      || purpose === 'configure' && request.nextUrl.searchParams.has('agentId')) {
      return NextResponse.json({ success: false, code: 'AGENT_REQUEST_INVALID', error: 'The agent list purpose is invalid.' }, { status: 400 });
    }
    let actor = actorFromRequest(request, session);
    if (actor.workspaceId) {
      const workspaceAccess = await requireSessionWorkspace(session, {
        workspaceId: actor.workspaceId,
        permissions: purpose === 'configure' ? ['canRead'] : ['canRead', 'canRunAgent'],
      });
      if (workspaceAccess.response) return workspaceAccess.response;
      actor = {
        ...actor,
        organizationId: purpose === 'configure' ? actor.organizationId ?? workspaceAccess.workspace.organizationId : workspaceAccess.workspace.organizationId,
        workspaceId: workspaceAccess.workspace.workspaceId,
        projectId: purpose === 'configure' ? actor.projectId ?? workspaceAccess.workspace.projectId : workspaceAccess.workspace.projectId,
      };
    }
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (agentId) {
      const inspected = await inspectManagedAgent(actor, agentId, {
        includeFiles: request.nextUrl.searchParams.get('includeFiles') === 'true',
        includeAccess: request.nextUrl.searchParams.get('includeAccess') === 'true',
      });
      return NextResponse.json({ success: true, data: inspected });
    }
    return NextResponse.json({ success: true, data: { agents: await listManagedAgents(actor, { purpose: purpose as 'use' | 'configure' }) } },
      purpose === 'configure' ? { headers: { 'Cache-Control': 'no-store' } } : undefined);
  } catch (error) {
    return errorResponse(error, 'Failed to list agents.');
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'agents-create-post' });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createManagedAgent(actorFromRequest(request, session), payload as CreateManagedAgentInput);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to create agent.');
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agents-update-patch' });
  if (!limited.ok) return limited.response;

  try {
    const parsed = updateAgentConfigurationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AgentWorkflowError('AGENT_CONFIGURATION_INVALID', 'The agent configuration contains invalid or unsupported fields.', 400);
    const payload = parsed.data;
    const agentId = payload.agentId;
    const actor = actorFromRequest(request, session);
    if (!hasAny(payload, ['name', 'iconId', 'enabledTools', 'defaultProviderInstallationId', 'defaultProvider', 'defaultModel',
      'defaultThinking', 'capabilities', 'relevantSkills', 'relevantConnections', 'workflow'])) {
      throw new AgentWorkflowError('AGENT_CONFIGURATION_INVALID', 'No supported agent changes were provided.', 400);
    }
    const { agent, workflow } = await updateManagedAgentConfiguration({ actor, ...payload });
    const access = await inspectManagedAgent(actor, agentId);
    return NextResponse.json({ success: true, data: { agent: { ...agent, access: access.access }, workflow } });
  } catch (error) {
    return errorResponse(error, 'Failed to update agent.');
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'agents-delete' });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = stringValue(payload.agentId) || request.nextUrl.searchParams.get('agentId') || '';
    const expectedRevision = payload.expectedRevision;
    const confirmationToken = stringValue(payload.confirmationToken) || '';
    if (typeof expectedRevision !== 'number') throw new Error('expectedRevision is required.');
    if (!confirmationToken) throw new Error('confirmationToken is required. Request a delete preview first.');
    const result = await deleteManagedAgent({
      actor: actorFromRequest(request, session),
      agentId,
      expectedRevision,
      confirmationToken,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to delete agent.');
  }
}
