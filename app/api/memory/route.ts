import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import {
  addMemory,
  deleteAgentMemory,
  deletePersonalMemory,
  exportAgentMemory,
  importPersonalMemory,
  listMemoryCollections,
  readAgentMemoryOwnerStats,
  readMemoryCollection,
  resolveAgentMemoryOwnerForUser,
  resolveMemoryScopeAccess,
  setAgentMemoryArchived,
  transferAgentMemory,
  updateMemoryReviewSettings,
  type MemoryServiceScope,
} from '@/app/lib/memory/service';
import type { MemoryScopeType } from '@/app/lib/memory/contract';
import { ensureMemoryManagerAgent, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { listManagedAgents } from '@/app/lib/agents/management-actions';

const MAX_MEMORY_PROMPT_TOKENS = 4_000;

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return session;
}

async function scopeFromRequest(
  request: NextRequest,
  userId: string,
  payload?: Record<string, unknown> | null,
): Promise<MemoryServiceScope> {
  const value = (key: string) => normalizedString(payload?.[key]) ?? (request.nextUrl.searchParams.get(key)?.trim() || null);
  const target = value('scope') ?? 'user';
  if (target !== 'user' && target !== 'agent' && target !== 'workspace' && target !== 'organization') {
    throw new Error('scope must be user, agent, workspace, or organization.');
  }
  if (target === 'agent') {
    const agentId = value('agentId');
    if (!agentId) throw new Error('agentId is required for agent memory.');
    return { target, userId, agentId: normalizeManagedAgentId(agentId) };
  }
  if (target === 'workspace') {
    const workspaceId = value('workspaceId');
    if (!workspaceId) throw new Error('workspaceId is required for workspace memory.');
    return { target, userId, workspaceId };
  }
  if (target === 'organization') {
    const organization = await readOrganizationPermissionForUser(userId);
    if (!organization.organizationId) throw new Error('Organization memory is not configured.');
    return { target, userId, organizationId: organization.organizationId };
  }
  return { target: target as Extract<MemoryScopeType, 'user'>, userId };
}

async function memorySettings(userId: string) {
  await ensureMemoryManagerAgent();
  const organization = await readOrganizationPermissionForUser(userId);
  const connection = await openDb();
  try {
    const settings = await connection.get(`
      SELECT automatic_memory_enabled, provider_installation_id, model_id,
        memory_prompt_max_tokens, sensitive_memory_enabled, updated_at
      FROM memory_user_settings WHERE user_id = ?
    `, [userId]) as Record<string, unknown> | undefined;
    const review = await connection.get(`
      SELECT
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN status IN ('scheduled', 'queued') THEN 1 ELSE 0 END) AS scheduled_count,
        SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_count,
        SUM(CASE WHEN status = 'awaiting_model_configuration' THEN 1 ELSE 0 END) AS awaiting_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        MAX(CASE WHEN status = 'completed' THEN completed_at ELSE NULL END) AS last_completed_at,
        MIN(CASE WHEN status IN ('scheduled', 'retry_wait') THEN scheduled_for ELSE NULL END) AS next_scheduled_at,
        MAX(CASE WHEN error_code IS NOT NULL THEN COALESCE(started_at, created_at) ELSE NULL END) AS last_error_at
      FROM memory_review_jobs WHERE user_id = ?
    `, [userId]) as Record<string, unknown> | undefined;
    const lastError = await connection.get(`
      SELECT error_code FROM memory_review_jobs
      WHERE user_id = ? AND error_code IS NOT NULL
      ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1
    `, [userId]) as Record<string, unknown> | undefined;
    const reviewCounts = {
      running: Number(review?.running_count ?? 0),
      scheduled: Number(review?.scheduled_count ?? 0),
      retrying: Number(review?.retry_count ?? 0),
      awaitingConfiguration: Number(review?.awaiting_count ?? 0),
      completed: Number(review?.completed_count ?? 0),
    };
    const pendingCount = reviewCounts.running + reviewCounts.scheduled + reviewCounts.retrying + reviewCounts.awaitingConfiguration;
    const reviewStatus = reviewCounts.running > 0
      ? 'running'
      : reviewCounts.retrying > 0
        ? 'retry_wait'
        : reviewCounts.awaitingConfiguration > 0
          ? 'awaiting_model_configuration'
          : reviewCounts.scheduled > 0
            ? 'scheduled'
            : 'idle';
    const catalog = organization.organizationId
      ? await readAppRuntimeCatalog(organization.organizationId)
      : null;
    return {
      automaticMemoryEnabled: settings?.automatic_memory_enabled === true || settings?.automatic_memory_enabled === 1,
      providerInstallationId: normalizedString(settings?.provider_installation_id),
      modelId: normalizedString(settings?.model_id),
      memoryPromptMaxTokens: Number(settings?.memory_prompt_max_tokens ?? 2_000),
      sensitiveMemoryEnabled: settings?.sensitive_memory_enabled === true || settings?.sensitive_memory_enabled === 1,
      updatedAt: Number(settings?.updated_at ?? 0),
      review: {
        status: reviewStatus,
        count: pendingCount,
        counts: reviewCounts,
        lastCompletedAt: Number(review?.last_completed_at ?? 0) || null,
        nextScheduledAt: Number(review?.next_scheduled_at ?? 0) || null,
        lastErrorCode: normalizedString(lastError?.error_code),
        lastErrorAt: Number(review?.last_error_at ?? 0) || null,
      },
      providers: (catalog?.providers ?? []).filter((provider) => provider.enabled && provider.status === 'ready').map((provider) => ({
        installationId: provider.installationId,
        name: provider.name,
        providerId: provider.providerId,
        models: provider.models.filter((model) => model.enabled).map((model) => ({ id: model.id, name: model.name })),
      })),
    };
  } finally { await connection.close(); }
}

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    if (request.nextUrl.searchParams.get('settings') === '1') {
      return NextResponse.json({ success: true, data: await memorySettings(session.user.id) });
    }
    if (request.nextUrl.searchParams.get('owners') === '1') {
      const [agents, stats] = await Promise.all([
        listManagedAgents({ userId: session.user.id, sessionId: session.session.id, source: 'ui' }),
        readAgentMemoryOwnerStats(session.user.id),
      ]);
      const statsByAgentId = new Map(stats.map((entry) => [entry.agentId, entry]));
      const activeAgentIds = new Set(agents.map((agent) => agent.agentId));
      const owners = [
        ...agents.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          iconId: agent.iconId,
          scopeType: agent.scopeType,
          status: 'active' as const,
          collectionCount: statsByAgentId.get(agent.agentId)?.collectionCount ?? 0,
          archivedCollectionCount: statsByAgentId.get(agent.agentId)?.archivedCollectionCount ?? 0,
          entryCount: statsByAgentId.get(agent.agentId)?.entryCount ?? 0,
          updatedAt: statsByAgentId.get(agent.agentId)?.updatedAt ?? 0,
        })),
        ...stats.filter((entry) => !entry.agentExists && !activeAgentIds.has(entry.agentId)).map((entry) => ({
          agentId: entry.agentId,
          name: 'Deleted agent',
          iconId: 'bot',
          scopeType: 'deleted' as const,
          status: 'deleted' as const,
          collectionCount: entry.collectionCount,
          archivedCollectionCount: entry.archivedCollectionCount,
          entryCount: entry.entryCount,
          updatedAt: entry.updatedAt,
        })),
      ];
      return NextResponse.json({ success: true, data: { owners } });
    }
    const scope = await scopeFromRequest(request, session.user.id);
    if (scope.target === 'agent') {
      await resolveAgentMemoryOwnerForUser({ userId: session.user.id, agentId: scope.agentId!, allowDeleted: true });
      if (request.nextUrl.searchParams.get('export') === '1') {
        return NextResponse.json({ success: true, data: await exportAgentMemory(session.user.id, scope.agentId!) });
      }
    }
    const permissions = await resolveMemoryScopeAccess(scope);
    const collections = await listMemoryCollections(scope);
    const selectedCollectionId = normalizedString(request.nextUrl.searchParams.get('collectionId'));
    const entries = selectedCollectionId
      ? await readMemoryCollection({
        ...scope,
        collectionId: selectedCollectionId,
        includeArchived: request.nextUrl.searchParams.get('includeArchived') === '1',
      })
      : { target: scope.target, entries: [] };
    return NextResponse.json({ success: true, data: { scope: scope.target, collections, entries: entries.entries, permissions } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  try {
    const automaticMemoryEnabled = payload.automaticMemoryEnabled === true;
    const sensitiveMemoryEnabled = payload.sensitiveMemoryEnabled === true;
    const memoryPromptMaxTokens = Number(payload.memoryPromptMaxTokens);
    if (!Number.isInteger(memoryPromptMaxTokens) || memoryPromptMaxTokens < 0 || memoryPromptMaxTokens > MAX_MEMORY_PROMPT_TOKENS) {
      throw new Error(`memoryPromptMaxTokens must be an integer between 0 and ${MAX_MEMORY_PROMPT_TOKENS}.`);
    }
    const providerInstallationId = normalizedString(payload.providerInstallationId);
    const modelId = normalizedString(payload.modelId);
    if (Boolean(providerInstallationId) !== Boolean(modelId)) throw new Error('Select both a provider and a model, or neither.');
    if (automaticMemoryEnabled && (!providerInstallationId || !modelId)) {
      throw new Error('Choose a provider and model before enabling automatic memory reviews.');
    }
    if (providerInstallationId && modelId) {
      const organization = await readOrganizationPermissionForUser(session.user.id);
      if (!organization.organizationId) throw new Error('Organization runtime catalog is unavailable.');
      const catalog = await readAppRuntimeCatalog(organization.organizationId);
      const provider = catalog.providers.find((candidate) => candidate.installationId === providerInstallationId);
      if (!provider?.enabled || provider.status !== 'ready' || !provider.models.some((model) => model.id === modelId && model.enabled)) {
        throw new Error('The selected provider or model is no longer available.');
      }
    }
    const reconciliation = await updateMemoryReviewSettings(session.user.id, {
      automaticMemoryEnabled,
      providerInstallationId,
      modelId,
      memoryPromptMaxTokens,
      sensitiveMemoryEnabled,
    });
    if (automaticMemoryEnabled && providerInstallationId && modelId) {
      const { triggerMemoryReviewWorker } = await import('@/app/lib/memory/review-worker');
      triggerMemoryReviewWorker();
    }
    return NextResponse.json({ success: true, data: { ...await memorySettings(session.user.id), reconciliation } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update memory settings.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  try {
    if (payload.action === 'transfer-agent-memory') {
      const sourceAgentId = normalizedString(payload.agentId);
      const targetAgentId = normalizedString(payload.targetAgentId);
      if (!sourceAgentId || !targetAgentId) throw new Error('agentId and targetAgentId are required for a transfer.');
      const result = await transferAgentMemory({
        userId: session.user.id,
        sourceAgentId: normalizeManagedAgentId(sourceAgentId),
        targetAgentId: normalizeManagedAgentId(targetAgentId),
      });
      return NextResponse.json({ success: true, data: result });
    }
    if (payload.action === 'archive-agent-memory' || payload.action === 'restore-agent-memory') {
      const agentId = normalizedString(payload.agentId);
      if (!agentId) throw new Error('agentId is required for agent memory.');
      const result = await setAgentMemoryArchived({
        userId: session.user.id,
        agentId: normalizeManagedAgentId(agentId),
        archived: payload.action === 'archive-agent-memory',
      });
      return NextResponse.json({ success: true, data: result });
    }
    if (payload.action === 'import') {
      if (!Array.isArray(payload.entries) || !payload.entries.every((entry) => typeof entry === 'string')) {
        throw new Error('entries must be an array of memory strings.');
      }
      const result = await importPersonalMemory({ userId: session.user.id, contents: payload.entries });
      return NextResponse.json({ success: true, data: result });
    }
    const content = normalizedString(payload.content);
    if (!content) throw new Error('content is required.');
    const scope = await scopeFromRequest(request, session.user.id, payload);
    if (scope.target === 'agent') {
      await resolveAgentMemoryOwnerForUser({ userId: session.user.id, agentId: scope.agentId!, allowDeleted: false });
    }
    const result = await addMemory({ ...scope, content });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to add memory.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    if (request.nextUrl.searchParams.get('scope') === 'agent') {
      const agentId = normalizedString(request.nextUrl.searchParams.get('agentId'));
      if (!agentId) throw new Error('agentId is required for agent memory.');
      if (request.nextUrl.searchParams.get('confirm') !== 'delete-agent-memory') {
        throw new Error('Explicit confirmation is required to delete agent memory.');
      }
      const result = await deleteAgentMemory(session.user.id, normalizeManagedAgentId(agentId));
      return NextResponse.json({ success: true, data: result });
    }
    if (request.nextUrl.searchParams.get('confirm') !== 'delete-personal-memory') {
      throw new Error('Explicit confirmation is required to delete personal memory.');
    }
    const result = await deletePersonalMemory(session.user.id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete personal memory.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
