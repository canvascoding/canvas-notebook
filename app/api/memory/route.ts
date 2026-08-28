import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import {
  addMemory,
  deletePersonalMemory,
  importPersonalMemory,
  listMemoryCollections,
  readMemoryCollection,
  resolveMemoryScopeAccess,
  type MemoryServiceScope,
} from '@/app/lib/memory/service';
import type { MemoryScopeType } from '@/app/lib/memory/contract';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';

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
    return { target, userId, agentId: normalizeManagedAgentId(value('agentId')) };
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
  const organization = await readOrganizationPermissionForUser(userId);
  const connection = await openDb();
  try {
    const settings = await connection.get(`
      SELECT automatic_memory_enabled, provider_installation_id, model_id,
        memory_prompt_max_tokens, sensitive_memory_enabled, updated_at
      FROM memory_user_settings WHERE user_id = ?
    `, [userId]) as Record<string, unknown> | undefined;
    const review = await connection.get(`
      SELECT status, COUNT(*) AS count
      FROM memory_review_jobs WHERE user_id = ?
      GROUP BY status ORDER BY status ASC
    `, [userId]) as Record<string, unknown> | undefined;
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
      review: review ? { status: String(review.status), count: Number(review.count) } : { status: 'idle', count: 0 },
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
    const scope = await scopeFromRequest(request, session.user.id);
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
    const connection = await openDb();
    try {
      const now = Date.now();
      await connection.run(`
        INSERT INTO memory_user_settings (
          user_id, automatic_memory_enabled, provider_installation_id, model_id,
          memory_prompt_max_tokens, sensitive_memory_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          automatic_memory_enabled = excluded.automatic_memory_enabled,
          provider_installation_id = excluded.provider_installation_id,
          model_id = excluded.model_id,
          memory_prompt_max_tokens = excluded.memory_prompt_max_tokens,
          sensitive_memory_enabled = excluded.sensitive_memory_enabled,
          updated_at = excluded.updated_at
      `, [session.user.id, automaticMemoryEnabled ? 1 : 0, providerInstallationId, modelId, memoryPromptMaxTokens, sensitiveMemoryEnabled ? 1 : 0, now, now]);
    } finally { await connection.close(); }
    return NextResponse.json({ success: true, data: await memorySettings(session.user.id) });
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
