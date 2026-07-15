import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createManagedAgent,
  deleteManagedAgent,
  inspectManagedAgent,
  listManagedAgents,
  managementErrorDetails,
  updateManagedAgentCapabilities,
  updateManagedAgentProfile,
  updateManagedAgentRuntime,
  type AgentManagementActor,
  type CreateManagedAgentInput,
} from '@/app/lib/agents/management-actions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function actorFromRequest(request: NextRequest, session: AuthSession): AgentManagementActor {
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    source: 'api',
    organizationId: request.nextUrl.searchParams.get('organizationId'),
    workspaceId: request.nextUrl.searchParams.get('workspaceId'),
    projectId: request.nextUrl.searchParams.get('projectId'),
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

function stringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
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
    const actor = actorFromRequest(request, session);
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (agentId) {
      const inspected = await inspectManagedAgent(actor, agentId, {
        includeFiles: request.nextUrl.searchParams.get('includeFiles') === 'true',
        includeAccess: request.nextUrl.searchParams.get('includeAccess') === 'true',
      });
      return NextResponse.json({ success: true, data: inspected });
    }
    return NextResponse.json({ success: true, data: { agents: await listManagedAgents(actor) } });
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
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = stringValue(payload.agentId);
    const expectedRevision = payload.expectedRevision;
    if (!agentId) throw new Error('agentId is required.');
    if (typeof expectedRevision !== 'number') throw new Error('expectedRevision is required.');
    const actor = actorFromRequest(request, session);
    let revision = expectedRevision;
    let agent;

    if (hasAny(payload, ['name', 'iconId'])) {
      agent = await updateManagedAgentProfile({
        actor,
        agentId,
        expectedRevision: revision,
        name: stringValue(payload.name),
        iconId: payload.iconId as string | null | undefined,
      });
      revision = agent.revision;
    }
    if (hasAny(payload, [
      'enabledTools',
      'defaultProviderInstallationId',
      'defaultProvider',
      'defaultModel',
      'defaultThinking',
    ])) {
      agent = await updateManagedAgentRuntime({
        actor,
        agentId,
        expectedRevision: revision,
        enabledTools: Object.hasOwn(payload, 'enabledTools') ? stringArrayValue(payload.enabledTools) : undefined,
        defaultProviderInstallationId: payload.defaultProviderInstallationId,
        defaultProvider: payload.defaultProvider,
        defaultModel: payload.defaultModel,
        defaultThinking: payload.defaultThinking,
        expectedCatalogRevision: payload.expectedCatalogRevision,
      });
      revision = agent.revision;
    }
    if (hasAny(payload, ['capabilities', 'relevantSkills', 'relevantConnections'])) {
      const result = await updateManagedAgentCapabilities({
        actor,
        agentId,
        expectedRevision: revision,
        capabilities: Array.isArray(payload.capabilities)
          ? payload.capabilities as Parameters<typeof updateManagedAgentCapabilities>[0]['capabilities']
          : undefined,
        relevantSkills: Object.hasOwn(payload, 'relevantSkills') ? stringArrayValue(payload.relevantSkills) : undefined,
        relevantConnections: Object.hasOwn(payload, 'relevantConnections') ? stringArrayValue(payload.relevantConnections) : undefined,
      });
      agent = result.agent;
      revision = agent.revision;
    }
    if (!agent) throw new Error('No supported agent changes were provided.');
    const access = await inspectManagedAgent(actor, agentId);
    return NextResponse.json({ success: true, data: { agent: { ...agent, access: access.access } } });
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
