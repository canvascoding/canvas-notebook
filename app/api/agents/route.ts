import { NextRequest, NextResponse } from 'next/server';

import {
  agentDefaultErrorResponse,
  parseAgentDefaultCatalogRevision,
  parseAgentDefaultFields,
  writeAgentDefaultWithCatalogValidation,
} from '@/app/lib/agent-runtime-policy/agent-default-service';
import { isAdminUser } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
} from '@/app/lib/agents/registry';
import { normalizeAgentIconId } from '@/app/lib/agents/icons';
import {
  isManagedAgentFileName,
  isWritableManagedAgentFileName,
  writeManagedAgentFile,
  type AgentManagedFileName,
} from '@/app/lib/agents/storage';
import { assertBrowserToolCanBeEnabled } from '@/app/lib/pi/browser/settings-service';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const AGENT_DEFAULT_FIELDS = [
  'defaultProviderInstallationId',
  'defaultProvider',
  'defaultModel',
  'defaultThinking',
] as const;

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function hasAgentDefaultMutation(payload: Record<string, unknown>): boolean {
  return AGENT_DEFAULT_FIELDS.some((field) => Object.hasOwn(payload, field));
}

async function requireAgentDefaultAdmin(session: AuthSession) {
  if (!isAdminUser(session.user)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Instance admin permission required.' },
        { status: 403 },
      ),
    };
  }
  const state = await readOrganizationPermissionForUser(session.user.id);
  if (!state.configured || !state.organizationId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          success: false,
          code: 'ORGANIZATION_SETUP_REQUIRED',
          error: 'Complete the app setup before configuring agent model defaults.',
        },
        { status: 409 },
      ),
    };
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, organizationId: state.organizationId };
}

function agentMutationError(error: unknown, fallback: string) {
  const runtimeError = agentDefaultErrorResponse(error);
  if (runtimeError.code !== 'AGENT_DEFAULT_UPDATE_FAILED') {
    return NextResponse.json(
      {
        success: false,
        code: runtimeError.code,
        error: runtimeError.message,
        ...(runtimeError.currentCatalogRevision === undefined
          ? {}
          : { currentCatalogRevision: runtimeError.currentCatalogRevision }),
      },
      { status: runtimeError.status },
    );
  }
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-list-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agents = await listAgentProfiles();
    return NextResponse.json({ success: true, data: { agents } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list agents.' },
      { status: 500 },
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function managedFilesValue(value: unknown): Partial<Record<AgentManagedFileName, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Partial<Record<AgentManagedFileName, string>> = {};
  for (const [fileName, content] of Object.entries(value)) {
    if (isManagedAgentFileName(fileName) && typeof content === 'string') {
      result[fileName] = content;
    }
  }
  return result;
}

async function writeInitialAgentFiles(
  agentId: string,
  files: Partial<Record<AgentManagedFileName, string>>,
  userId: string,
): Promise<void> {
  for (const [fileName, content] of Object.entries(files)) {
    if (!isManagedAgentFileName(fileName) || !isWritableManagedAgentFileName(fileName, agentId)) {
      continue;
    }
    await writeManagedAgentFile(fileName, content ?? '', agentId, { userId });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-create-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const enabledTools = stringArrayValue(payload.enabledTools);
    await assertBrowserToolCanBeEnabled({ nextEnabledTools: enabledTools });
    const defaultSelection = parseAgentDefaultFields({
      providerInstallationId: payload.defaultProviderInstallationId,
      providerId: payload.defaultProvider,
      modelId: payload.defaultModel,
      thinkingLevel: payload.defaultThinking,
    });
    let organizationId: string | undefined;
    let expectedCatalogRevision: number | undefined;
    if (defaultSelection) {
      const admin = await requireAgentDefaultAdmin(session);
      if (!admin.ok) return admin.response;
      organizationId = admin.organizationId;
      expectedCatalogRevision = parseAgentDefaultCatalogRevision(payload.expectedCatalogRevision, true)!;
    }
    let agent = await createAgentProfile({
      name: stringValue(payload.name) || '',
      agentId: stringValue(payload.agentId) || null,
      iconId: normalizeAgentIconId(payload.iconId),
      enabledTools,
      relevantSkills: stringArrayValue(payload.relevantSkills),
      relevantConnections: stringArrayValue(payload.relevantConnections),
    });
    let catalogRevision: number | undefined;
    if (defaultSelection && organizationId) {
      try {
        const result = await writeAgentDefaultWithCatalogValidation({
          organizationId,
          agentId: agent.agentId,
          selection: defaultSelection,
          expectedCatalogRevision,
        });
        catalogRevision = result.catalogRevision ?? undefined;
        agent = (await getAgentProfile(agent.agentId)) ?? agent;
      } catch (error) {
        await deleteAgentProfile(agent.agentId).catch(() => undefined);
        throw error;
      }
    }
    const managedFiles = managedFilesValue(payload.files);
    await writeInitialAgentFiles(agent.agentId, managedFiles, session.user.id);
    await recordAuditEvent({
      organizationId,
      userId: session.user.id,
      agentId: agent.agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agent.agentId,
      action: 'agent.create',
      status: 'success',
      summary: `Agent ${agent.agentId} created.`,
      metadata: {
        name: agent.name,
        defaultProviderInstallationId: agent.defaultProviderInstallationId,
        defaultProvider: agent.defaultProvider,
        defaultModel: agent.defaultModel,
        defaultThinking: agent.defaultThinking,
        catalogRevision,
        managedFiles: Object.keys(managedFiles),
      },
    });
    return NextResponse.json({ success: true, data: { agent } });
  } catch (error) {
    return agentMutationError(error, 'Failed to create agent.');
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-update-patch',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = stringValue(payload.agentId);
    if (!agentId) {
      throw new Error('agentId is required.');
    }
    if (typeof payload.name === 'string' && !payload.name.trim()) {
      // Validate profile fields before the catalog-guarded default write so a
      // rejected combined PATCH cannot leave a partially updated agent.
      throw new Error('Agent name is required.');
    }
    const runtimeMutation = hasAgentDefaultMutation(payload);
    const existingAgent = runtimeMutation || Object.hasOwn(payload, 'enabledTools')
      ? await getAgentProfile(agentId)
      : null;
    if ((runtimeMutation || Object.hasOwn(payload, 'enabledTools')) && !existingAgent) {
      throw new Error('Agent not found.');
    }
    const nextEnabledTools = Object.hasOwn(payload, 'enabledTools') ? stringArrayValue(payload.enabledTools) : undefined;
    if (nextEnabledTools !== undefined) {
      await assertBrowserToolCanBeEnabled({
        previousEnabledTools: existingAgent?.enabledTools ?? null,
        nextEnabledTools,
      });
    }

    let defaultSelection: ReturnType<typeof parseAgentDefaultFields> | undefined;
    let organizationId: string | undefined;
    let catalogRevision: number | undefined;
    if (runtimeMutation) {
      if (existingAgent?.type === 'main') {
        throw new Error('The Canvas Agent runtime is configured through app and user runtime settings.');
      }
      const admin = await requireAgentDefaultAdmin(session);
      if (!admin.ok) return admin.response;
      organizationId = admin.organizationId;
      defaultSelection = parseAgentDefaultFields({
        providerInstallationId: Object.hasOwn(payload, 'defaultProviderInstallationId')
          ? payload.defaultProviderInstallationId
          : existingAgent?.defaultProviderInstallationId,
        providerId: Object.hasOwn(payload, 'defaultProvider')
          ? payload.defaultProvider
          : existingAgent?.defaultProvider,
        modelId: Object.hasOwn(payload, 'defaultModel')
          ? payload.defaultModel
          : existingAgent?.defaultModel,
        thinkingLevel: Object.hasOwn(payload, 'defaultThinking')
          ? payload.defaultThinking
          : existingAgent?.defaultThinking,
      });
      if (defaultSelection) {
        const expectedCatalogRevision = parseAgentDefaultCatalogRevision(payload.expectedCatalogRevision, true)!;
        const validation = await writeAgentDefaultWithCatalogValidation({
          organizationId,
          agentId,
          selection: defaultSelection,
          expectedCatalogRevision,
        });
        catalogRevision = validation.catalogRevision ?? undefined;
      } else {
        await writeAgentDefaultWithCatalogValidation({
          organizationId,
          agentId,
          selection: null,
        });
      }
    }
    const agent = await updateAgentProfile({
      agentId,
      name: stringValue(payload.name),
      iconId: Object.hasOwn(payload, 'iconId') ? normalizeAgentIconId(payload.iconId) : undefined,
      enabledTools: nextEnabledTools,
      relevantSkills: Object.hasOwn(payload, 'relevantSkills') ? stringArrayValue(payload.relevantSkills) : undefined,
      relevantConnections: Object.hasOwn(payload, 'relevantConnections') ? stringArrayValue(payload.relevantConnections) : undefined,
    });
    await recordAuditEvent({
      organizationId,
      userId: session.user.id,
      agentId: agent.agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agent.agentId,
      action: 'agent.update',
      status: 'success',
      summary: `Agent ${agent.agentId} updated.`,
      metadata: {
        changedFields: Object.keys(payload).filter((key) => key !== 'files'),
        defaultProviderInstallationId: agent.defaultProviderInstallationId,
        defaultProvider: agent.defaultProvider,
        defaultModel: agent.defaultModel,
        defaultThinking: agent.defaultThinking,
        catalogRevision,
      },
    });
    return NextResponse.json({ success: true, data: { agent } });
  } catch (error) {
    return agentMutationError(error, 'Failed to update agent.');
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-delete',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (!agentId) {
      throw new Error('agentId is required.');
    }
    await deleteAgentProfile(agentId);
    await recordAuditEvent({
      userId: session.user.id,
      agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agentId,
      action: 'agent.delete',
      status: 'success',
      summary: `Agent ${agentId} deleted.`,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete agent.' },
      { status: 400 },
    );
  }
}
