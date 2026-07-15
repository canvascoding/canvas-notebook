import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { aiSessions, aiMessages, user, piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { and, desc, eq, inArray, lt, or, isNull, sql, type SQL } from 'drizzle-orm';
import { type AgentId, isAgentId } from '@/app/lib/agents/catalog';
import { enforceAiSessionRetention } from '@/app/lib/agents/session-retention';
import { readAgentRuntimeConfig, providerIdToAgentId } from '@/app/lib/agents/storage';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  getActiveRuntimeStatusSummaries,
  invalidateRuntime,
  withRuntimeSessionOperation,
} from '@/app/lib/pi/runtime-service';
import { DEFAULT_AGENT_ID, WEB_CHANNEL_ID, normalizeStoredChannelId, webChannelSessionKey } from '@/app/lib/channels/constants';
import { ensureDefaultAgent } from '@/app/lib/channels/agents';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { listAgentAccessForUser, requireAgentAccess } from '@/app/lib/agents/access';
import { deletePiSessionsByDbIds } from '@/app/lib/pi/session-deletion';
import { createPiSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import { createPiSessionWithRuntimeSnapshot } from '@/app/lib/pi/session-store';
import {
  findOwnedPiSessionForRuntime,
  isPiSessionInWorkspace,
} from '@/app/lib/pi/session-runtime-access';
import { markPiSessionAsReadForUser, markPiSessionAsUnreadForUser } from '@/app/lib/chat/session-read-state';
import {
  resolveAgentSessionWorkspaceForUser,
  storedPiSessionWorkspaceToSummary,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';
import {
  hasSessionRuntimeUpdate,
  parseSessionRuntimeUpdate,
  prepareSessionRuntimeSnapshot,
  replaceSessionRuntimeSnapshot,
  type AiSessionRuntimeUpdate,
} from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { AiRuntimeInputError, runtimeErrorResponse } from '@/app/lib/agent-runtime-policy/runtime-service';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

type CreateSessionPayload = {
  title?: string;
  model?: string;
  thinkingLevel?: string;
  agentId?: string;
  channelId?: string;
  channelSessionKey?: string;
  workspaceId?: string;
  workspace?: ChatRequestContext['workspace'];
  runtimeSelection?: unknown;
  expectedCatalogRevision?: unknown;
  expectedPolicyRevision?: unknown;
};

type RenameSessionPayload = {
  sessionId?: string;
  agentId?: string;
  workspaceId?: string;
  title?: string;
  markAsRead?: boolean;
  markAsUnread?: boolean;
  markAllAsRead?: boolean;
  lastMessageAt?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  runtimeSelection?: unknown;
  expectedCatalogRevision?: unknown;
  expectedPolicyRevision?: unknown;
};

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function getSessionActivityTime(sessionItem: { createdAt: Date; lastMessageAt?: Date | null }): number {
  return (sessionItem.lastMessageAt ?? sessionItem.createdAt).getTime();
}

function resolveRequestedModel(value: unknown): AgentId | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return isAgentId(normalized) ? normalized : null;
}

function buildSessionId(): string {
  return `sess-${Date.now()}-${randomUUID()}`;
}

function normalizeTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, 120);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSessionAgentId(value: unknown): string {
  return normalizeManagedAgentId(normalizeOptionalString(value));
}

function resolveCreateSessionWorkspaceId(payload: CreateSessionPayload): string | null {
  return normalizeOptionalString(payload.workspaceId) ?? normalizeOptionalString(payload.workspace?.workspaceId);
}

function buildPiSessionWorkspaceCondition(workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>): SQL {
  if (workspace.workspaceType === 'personal') {
    return or(eq(piSessions.workspaceId, workspace.workspaceId), isNull(piSessions.workspaceId))!;
  }
  return eq(piSessions.workspaceId, workspace.workspaceId);
}

function normalizeThinkingLevel(value: unknown): PiThinkingLevel | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

async function resolveDefaultModel(): Promise<AgentId> {
  const config = await readAgentRuntimeConfig();
  return providerIdToAgentId(config.provider.id);
}

function sessionRuntimeErrorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Agent not found.') {
    return NextResponse.json(
      { success: false, code: 'AGENT_NOT_FOUND', error: 'Agent not found.' },
      { status: 404 },
    );
  }
  const response = runtimeErrorResponse(error);
  if (response.status >= 500) {
    console.error('[API Sessions] Runtime selection failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return NextResponse.json(
    { success: false, code: response.code, error: response.message, ...(response.details ?? {}) },
    { status: response.status },
  );
}

function legacyCompatibleRuntimeUpdate(input: {
  prepared: Awaited<ReturnType<typeof prepareSessionRuntimeSnapshot>>;
  provider: string | null;
  model: string | null;
  thinkingLevel: PiThinkingLevel | null;
}): AiSessionRuntimeUpdate | null {
  if (!input.provider && !input.model && !input.thinkingLevel) return null;

  const current = input.prepared.snapshot.selection;
  const targetProviderId = input.provider ?? current.providerId;
  const currentProvider = input.prepared.resolution.providers.find(
    (provider) => provider.installationId === current.providerInstallationId,
  );
  const matchingProviders = input.prepared.resolution.providers.filter(
    (provider) => provider.providerId === targetProviderId && provider.selectable,
  );
  const targetProvider = targetProviderId === current.providerId
    ? currentProvider
    : matchingProviders.length === 1
      ? matchingProviders[0]
      : null;
  if (!targetProvider) {
    throw new AiRuntimeInputError(
      'RUNTIME_SELECTION_REQUIRED',
      'runtimeSelection is required when a provider has multiple eligible installations.',
    );
  }

  const targetModelId = input.model
    ?? (targetProvider.installationId === current.providerInstallationId
      ? current.modelId
      : targetProvider.models.find((model) => model.isProviderDefault)?.id ?? targetProvider.models[0]?.id)
    ?? '';
  const targetModel = targetProvider.models.find((model) => model.id === targetModelId);
  const requestedThinking = input.thinkingLevel
    ?? (targetProvider.installationId === current.providerInstallationId && targetModelId === current.modelId
      ? current.thinkingLevel
      : targetModel?.thinkingLevels.includes('off')
        ? 'off'
        : targetModel?.thinkingLevels[0] ?? 'off');

  return {
    selection: {
      providerInstallationId: targetProvider.installationId,
      providerId: targetProvider.providerId,
      modelId: targetModelId,
      thinkingLevel: requestedThinking,
    },
    expectedCatalogRevision: input.prepared.resolution.catalogRevision,
    expectedPolicyRevision: input.prepared.resolution.policyRevision,
  };
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'sessions-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const legacyModelFilter = resolveRequestedModel(searchParams.get('model'));
  const channelIdFilter = searchParams.get('channelId');
  const countOnly = searchParams.get('countOnly') === 'true';
  const olderThanDays = searchParams.get('olderThanDays');
  const rawAgentIdFilter = searchParams.get('agentId');
  const workspaceIdFilter = normalizeOptionalString(searchParams.get('workspaceId'));
  const includeAllAgentSessions = rawAgentIdFilter === 'all';
  let agentIdFilter: string | null;

  try {
    agentIdFilter = includeAllAgentSessions ? null : normalizeSessionAgentId(rawAgentIdFilter);
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
  }

  const accessibleAgentIds = includeAllAgentSessions
    ? [...(await listAgentAccessForUser(session.user.id)).entries()]
        .filter(([, access]) => access.canUse)
        .map(([agentId]) => agentId)
    : [agentIdFilter!];
  if (!includeAllAgentSessions) {
    try {
      await requireAgentAccess(session.user.id, agentIdFilter!, 'canUse');
    } catch {
      return NextResponse.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' }, { status: 403 });
    }
  }

  try {
    const legacyTablesAvailable = await legacyAiTablesExist();
    const cutoff = olderThanDays ? new Date(Date.now() - parseInt(olderThanDays, 10) * 24 * 60 * 60 * 1000) : null;
    let scopedWorkspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null = null;
    if (workspaceIdFilter) {
      try {
        scopedWorkspace = await resolveAgentSessionWorkspaceForUser({
          userId: session.user.id,
          workspaceId: workspaceIdFilter,
          permissions: ['canRead', 'canRunAgent'],
        });
      } catch {
        return NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 403 });
      }
    }
    const piWorkspaceCondition = scopedWorkspace ? buildPiSessionWorkspaceCondition(scopedWorkspace) : null;

    if (countOnly && cutoff) {
      const piCutoffCondition = cutoff
        ? or(lt(piSessions.lastMessageAt, cutoff), and(isNull(piSessions.lastMessageAt), lt(piSessions.createdAt, cutoff)))
        : undefined;
      const piCountConditions: SQL[] = [eq(piSessions.userId, session.user.id), piCutoffCondition!];
      if (!includeAllAgentSessions) {
        piCountConditions.push(eq(piSessions.agentId, agentIdFilter!));
      } else {
        piCountConditions.push(inArray(piSessions.agentId, accessibleAgentIds));
      }
      if (piWorkspaceCondition) {
        piCountConditions.push(piWorkspaceCondition);
      }

      const piOlderCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(piSessions)
        .where(and(...piCountConditions));

      const includeLegacyCount = legacyTablesAvailable &&
        (includeAllAgentSessions || agentIdFilter === DEFAULT_AGENT_ID) &&
        (!scopedWorkspace || scopedWorkspace.workspaceType === 'personal');
      const legacyCutoffCondition = includeLegacyCount && cutoff
        ? and(eq(aiSessions.userId, session.user.id), lt(aiSessions.createdAt, cutoff))
        : undefined;

      const legacyOlderCount = legacyCutoffCondition
        ? await db
            .select({ count: sql<number>`count(*)` })
            .from(aiSessions)
            .where(legacyCutoffCondition)
        : [{ count: 0 }];

      return NextResponse.json({
        success: true,
        count: Number(piOlderCount[0].count) + Number(legacyOlderCount[0].count),
      });
    }

    const legacyConditions: SQL[] = [eq(aiSessions.userId, session.user.id)];
    if (legacyModelFilter) {
      legacyConditions.push(eq(aiSessions.model, legacyModelFilter));
    }
    const whereClause = and(...legacyConditions);
    const normalizedChannelFilter = channelIdFilter ? normalizeStoredChannelId(channelIdFilter) : null;
    const filteredPiSessionIds = normalizedChannelFilter
      ? await db
          .select({ sessionId: sessionChannelLinks.sessionId })
          .from(sessionChannelLinks)
          .where(and(
            eq(sessionChannelLinks.userId, session.user.id),
            eq(sessionChannelLinks.channelId, normalizedChannelFilter),
          ))
      : null;
    const filteredPiSessionIdValues = filteredPiSessionIds?.map((row) => row.sessionId) ?? null;
    const includeLegacySessions = legacyTablesAvailable &&
      (includeAllAgentSessions || agentIdFilter === DEFAULT_AGENT_ID) &&
      (!normalizedChannelFilter || normalizedChannelFilter === WEB_CHANNEL_ID) &&
      (!scopedWorkspace || scopedWorkspace.workspaceType === 'personal');
    const piBaseConditions: SQL[] = [eq(piSessions.userId, session.user.id)];
    if (!includeAllAgentSessions) {
      piBaseConditions.push(eq(piSessions.agentId, agentIdFilter!));
    } else {
      piBaseConditions.push(inArray(piSessions.agentId, accessibleAgentIds));
    }
    if (piWorkspaceCondition) {
      piBaseConditions.push(piWorkspaceCondition);
    }
    const piBaseWhere = and(...piBaseConditions);

    const [legacySessions, newPiSessions] = await Promise.all([
      includeLegacySessions ? db
        .select({
          id: aiSessions.id,
          sessionId: aiSessions.sessionId,
          userId: aiSessions.userId,
          title: aiSessions.title,
          model: aiSessions.model,
          createdAt: aiSessions.createdAt,
          creatorName: user.name,
          creatorEmail: user.email,
        })
        .from(aiSessions)
        .leftJoin(user, eq(aiSessions.userId, user.id))
        .where(whereClause)
        .orderBy(desc(aiSessions.createdAt))
        .limit(100) : Promise.resolve([]),
      db
        .select({
          id: piSessions.id,
          sessionId: piSessions.sessionId,
          userId: piSessions.userId,
          title: piSessions.title,
          titleGenerationState: piSessions.titleGenerationState,
          agentId: piSessions.agentId,
          model: piSessions.model,
          thinkingLevel: piSessions.thinkingLevel,
          provider: piSessions.provider,
          createdAt: piSessions.createdAt,
          lastMessageAt: piSessions.lastMessageAt,
          lastViewedAt: piSessions.lastViewedAt,
          organizationId: piSessions.organizationId,
          workspaceId: piSessions.workspaceId,
          workspaceType: piSessions.workspaceType,
          workspaceName: piSessions.workspaceName,
          workspaceRootRelativePath: piSessions.workspaceRootRelativePath,
          creatorName: user.name,
          creatorEmail: user.email,
        })
        .from(piSessions)
        .leftJoin(user, eq(piSessions.userId, user.id))
        .where(
          filteredPiSessionIdValues
            ? filteredPiSessionIdValues.length > 0
              ? and(piBaseWhere, inArray(piSessions.sessionId, filteredPiSessionIdValues))
              : and(piBaseWhere, sql`1 = 0`)
            : piBaseWhere
        )
        .orderBy(desc(sql`coalesce(${piSessions.lastMessageAt}, ${piSessions.createdAt})`), desc(piSessions.createdAt))
        .limit(100)
    ]);

    const combined = [
      ...legacySessions.map(s => ({ ...s, agentId: DEFAULT_AGENT_ID, engine: 'legacy' as const, channelId: 'app' as const, lastMessageAt: null as Date | null, lastViewedAt: null as Date | null })),
      ...newPiSessions.map(s => ({
        ...s, 
        engine: 'pi' as const,
        channelId: 'web' as const,
        lastMessageAt: s.lastMessageAt,
        lastViewedAt: s.lastViewedAt
      }))
    ].sort((a, b) => getSessionActivityTime(b) - getSessionActivityTime(a));

    const runtimeStatusSummaries = await getActiveRuntimeStatusSummaries({
      userId: session.user.id,
      sessionIds: combined
        .filter((item) => item.engine === 'pi')
        .map((item) => item.sessionId),
    });

    const mappedSessions = combined.map((item) => {
      const hasUnread = item.engine === 'pi' && hasUnreadAssistantResponse(item.lastMessageAt, item.lastViewedAt);
      const runtimeStatus = item.engine === 'pi' ? runtimeStatusSummaries[item.sessionId] : undefined;
      if (hasUnread) {
        console.log(`[API Sessions] Unread session: sessionId=${item.sessionId}, lastMessageAt=${item.lastMessageAt?.toISOString()}, lastViewedAt=${item.lastViewedAt?.toISOString()}`);
      }
      return {
        id: item.id,
        sessionId: item.sessionId,
        userId: item.userId,
        title: item.title,
        titleGenerationState: 'titleGenerationState' in item ? item.titleGenerationState : null,
        agentId: item.agentId,
        model: item.model,
        provider: 'provider' in item ? item.provider : null,
        thinkingLevel: 'thinkingLevel' in item ? item.thinkingLevel : null,
        engine: item.engine,
        createdAt: item.createdAt,
        lastMessageAt: item.lastMessageAt,
        lastViewedAt: item.lastViewedAt,
        runtimePhase: runtimeStatus?.phase ?? null,
        runtimeActiveToolName: runtimeStatus?.activeToolName ?? null,
        channelId: item.channelId,
        hasUnread,
        workspace: item.engine === 'pi'
          ? storedPiSessionWorkspaceToSummary({
            workspaceId: 'workspaceId' in item ? item.workspaceId : null,
            workspaceType: 'workspaceType' in item ? item.workspaceType : null,
            workspaceName: 'workspaceName' in item ? item.workspaceName : null,
            workspaceRootRelativePath: 'workspaceRootRelativePath' in item ? item.workspaceRootRelativePath : null,
            organizationId: 'organizationId' in item ? item.organizationId : null,
          })
          : null,
        creator: {
          name: item.creatorName || null,
          email: item.creatorEmail || null,
        },
      };
    });

    const unreadCount = mappedSessions.filter(s => s.hasUnread).length;
    console.log(`[API Sessions] GET: returning ${mappedSessions.length} sessions, ${unreadCount} unread`);

    return NextResponse.json({
      success: true,
      sessions: mappedSessions,
    });
  } catch (error) {
    console.error('[API] Failed to fetch sessions:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
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
    keyPrefix: 'sessions-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const engine = getActiveAiAgentEngine();

  try {
    const rawPayload = await request.json().catch(() => ({})) as unknown;
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_SESSION_INPUT', error: 'Request body must be an object.' },
        { status: 400 },
      );
    }
    const payload = rawPayload as CreateSessionPayload;
    const sessionId = buildSessionId();
    const title = normalizeTitle(payload.title, DEFAULT_SESSION_TITLE);
    const hasExplicitTitle = typeof payload.title === 'string' && payload.title.trim().length > 0;

    if (engine === 'pi') {
      const requestedModel = normalizeOptionalString(payload.model);
      const requestedThinkingLevel = normalizeThinkingLevel(payload.thinkingLevel);

      if (payload.thinkingLevel !== undefined && !requestedThinkingLevel) {
        return NextResponse.json({ success: false, error: 'Invalid thinking level' }, { status: 400 });
      }

      await ensureDefaultAgent();
      let requestedAgentId: string;
      try {
        requestedAgentId = normalizeSessionAgentId(payload.agentId);
      } catch {
        return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
      }
      const requestedAgent = await getAgentProfile(requestedAgentId);
      if (!requestedAgent) {
        return NextResponse.json({ success: false, error: 'Agent not found' }, { status: 404 });
      }
      let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>;
      try {
        workspace = await resolveAgentSessionWorkspaceForUser({
          userId: session.user.id,
          workspaceId: resolveCreateSessionWorkspaceId(payload),
          permissions: ['canRead', 'canRunAgent'],
        });
      } catch {
        return NextResponse.json(
          { success: false, code: 'WORKSPACE_ACCESS_DENIED', error: 'Workspace not found or inaccessible.' },
          { status: 403 },
        );
      }
      try {
        await requireAgentAccess(session.user.id, requestedAgentId, 'canUse', {
          organizationId: workspace.organizationId,
          workspaceId: workspace.workspaceId,
          projectId: workspace.projectId,
        });
      } catch {
        return NextResponse.json(
          { success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' },
          { status: 403 },
        );
      }
      if (!workspace.organizationId) {
        return NextResponse.json({
          success: false,
          code: 'ORGANIZATION_SETUP_REQUIRED',
          error: 'Complete the app setup first.',
        }, { status: 409 });
      }

      const context = {
        organizationId: workspace.organizationId,
        userId: session.user.id,
        workspaceId: workspace.workspaceId,
        workspaceType: workspace.workspaceType,
        agentId: requestedAgentId,
        sessionId: null,
        requestedSelection: null,
      };
      let runtimeUpdate = hasSessionRuntimeUpdate(payload)
        ? parseSessionRuntimeUpdate(payload)
        : null;
      let prepared = await prepareSessionRuntimeSnapshot({ context, update: runtimeUpdate });
      if (!runtimeUpdate) {
        runtimeUpdate = legacyCompatibleRuntimeUpdate({
          prepared,
          provider: null,
          model: requestedModel,
          thinkingLevel: requestedThinkingLevel,
        });
        if (runtimeUpdate) {
          prepared = await prepareSessionRuntimeSnapshot({ context, update: runtimeUpdate });
        }
      }

      const promptSnapshot = await createPiSystemPromptSnapshot(requestedAgentId, {
        userId: session.user.id,
        userName: session.user.name,
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
      });
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : 'app';
      const normalizedChannelId = normalizeStoredChannelId(channelId);
      const channelSessionKey = typeof payload.channelSessionKey === 'string'
        ? payload.channelSessionKey
        : normalizedChannelId === WEB_CHANNEL_ID
          ? webChannelSessionKey(session.user.id)
          : null;
      const workspaceFields = workspaceToPiSessionFields(workspace);

      const inserted = await createPiSessionWithRuntimeSnapshot({
        sessionId,
        userId: session.user.id,
        agentId: requestedAgentId,
        title,
        titleGenerationState: hasExplicitTitle ? 'manual' : 'pending',
        workspace: workspaceFields,
        runtimeSnapshot: prepared.snapshot,
        systemPromptSnapshot: promptSnapshot,
      });

      await ensureSessionChannelLink({
        sessionId,
        userId: session.user.id,
        channelId: normalizedChannelId,
        channelSessionKey: channelSessionKey || webChannelSessionKey(session.user.id),
        displayName: title,
        isPrimary: normalizedChannelId === WEB_CHANNEL_ID,
      });

      await recordAuditEvent({
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        userId: session.user.id,
        agentId: requestedAgentId,
        sessionId,
        source: 'agent-runtime',
        eventType: 'user',
        entityType: 'pi_session',
        entityId: sessionId,
        action: 'pi_session_runtime.pin',
        status: 'success',
        summary: 'AI runtime selection pinned for a new chat session.',
        metadata: {
          catalogRevision: prepared.snapshot.catalogRevision,
          policyRevision: prepared.snapshot.policyRevision,
          selectionSource: prepared.snapshot.selectionSource,
          selection: prepared.snapshot.selection,
        },
      });

      return NextResponse.json({
        success: true,
        session: {
          ...inserted,
          engine: 'pi',
          workspace: storedPiSessionWorkspaceToSummary(inserted),
          creator: {
            name: session.user.name || null,
            email: session.user.email || null,
          },
        },
        runtime: prepared.snapshot,
        resolution: prepared.resolution,
      });
    }

    const requestedModel = resolveRequestedModel(payload.agentId ?? payload.model);
    const model = requestedModel ?? (await resolveDefaultModel());

    if (!(await legacyAiTablesExist())) {
      return NextResponse.json({ success: false, error: 'Legacy session engine is no longer available' }, { status: 410 });
    }

    const inserted = await db
      .insert(aiSessions)
      .values({
        sessionId,
        userId: session.user.id,
        model,
        title,
        createdAt: new Date(),
      })
      .returning();

    const created = inserted[0];
    await enforceAiSessionRetention();

    return NextResponse.json({
      success: true,
      session: {
        ...created,
        agentId: DEFAULT_AGENT_ID,
        engine: 'legacy',
        creator: {
          name: session.user.name || null,
          email: session.user.email || null,
        },
      },
    });
  } catch (error) {
    return sessionRuntimeErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: `sessions-patch:${session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const rawPayload = await request.json().catch(() => null) as unknown;
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_SESSION_INPUT', error: 'Request body must be an object.' },
        { status: 400 },
      );
    }
    const payload = rawPayload as RenameSessionPayload;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const markAsRead = typeof payload.markAsRead === 'boolean' ? payload.markAsRead : false;
    const markAsUnread = typeof payload.markAsUnread === 'boolean' ? payload.markAsUnread : false;
    const markAllAsRead = typeof payload.markAllAsRead === 'boolean' ? payload.markAllAsRead : false;
    const workspaceIdFilter = normalizeOptionalString(payload.workspaceId);
    const requestedProvider = normalizeOptionalString(payload.provider);
    const requestedModel = normalizeOptionalString(payload.model);
    const requestedThinkingLevel = normalizeThinkingLevel(payload.thinkingLevel);
    let requestedAgentId: string;

    try {
      requestedAgentId = normalizeSessionAgentId(payload.agentId);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
    }
    try {
      await requireAgentAccess(session.user.id, requestedAgentId, 'canUse');
    } catch {
      return NextResponse.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' }, { status: 403 });
    }

    if (payload.thinkingLevel !== undefined && !requestedThinkingLevel) {
      return NextResponse.json({ success: false, error: 'Invalid thinking level' }, { status: 400 });
    }
    if (payload.provider !== undefined && !requestedProvider) {
      return NextResponse.json({ success: false, error: 'Invalid provider' }, { status: 400 });
    }

    // Handle mark all as read
    if (markAllAsRead && !sessionId) {
      const now = new Date();
      let scopedWorkspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null = null;
      if (workspaceIdFilter) {
        try {
          scopedWorkspace = await resolveAgentSessionWorkspaceForUser({
            userId: session.user.id,
            workspaceId: workspaceIdFilter,
            permissions: ['canRead', 'canRunAgent'],
          });
        } catch {
          return NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 403 });
        }
      }
      const conditions: SQL[] = [eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)];
      if (scopedWorkspace) {
        conditions.push(buildPiSessionWorkspaceCondition(scopedWorkspace));
      }
      await db
        .update(piSessions)
        .set({ lastViewedAt: now, updatedAt: now })
        .where(and(...conditions));

      return NextResponse.json({
        success: true,
        lastViewedAt: now.toISOString(),
      });
    }

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    if (hasSessionRuntimeUpdate(payload) || requestedProvider || requestedModel || requestedThinkingLevel) {
      const piSession = await findOwnedPiSessionForRuntime({
        sessionId,
        userId: session.user.id,
        agentId: requestedAgentId,
      });
      if (!piSession) {
        return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
      }
      let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>;
      try {
        workspace = await resolveAgentSessionWorkspaceForUser({
          userId: session.user.id,
          workspaceId: workspaceIdFilter ?? piSession.workspaceId,
          permissions: ['canRead', 'canRunAgent'],
        });
      } catch {
        return NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 403 });
      }
      if (!isPiSessionInWorkspace(piSession, workspace)) {
        return NextResponse.json(
          { success: false, code: 'SESSION_WORKSPACE_MISMATCH', error: 'Session is outside the active workspace.' },
          { status: 403 },
        );
      }
      if (!workspace.organizationId) {
        return NextResponse.json(
          { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
          { status: 409 },
        );
      }
      const organizationId = workspace.organizationId;

      const runtimeChange = await withRuntimeSessionOperation(sessionId, session.user.id, async () => {
        const activeRuntimeStatuses = await getActiveRuntimeStatusSummaries({
          userId: session.user.id,
          sessionIds: [sessionId],
        });
        if (activeRuntimeStatuses[sessionId]) {
          return { busy: true as const };
        }

        const context = {
          organizationId,
          userId: session.user.id,
          workspaceId: workspace.workspaceId,
          workspaceType: workspace.workspaceType,
          agentId: requestedAgentId,
          sessionId,
          requestedSelection: null,
        };
        let runtimeUpdate: AiSessionRuntimeUpdate;
        if (hasSessionRuntimeUpdate(payload)) {
          runtimeUpdate = parseSessionRuntimeUpdate(payload);
        } else {
          const prepared = await prepareSessionRuntimeSnapshot({ context });
          const compatibleUpdate = legacyCompatibleRuntimeUpdate({
            prepared,
            provider: requestedProvider,
            model: requestedModel,
            thinkingLevel: requestedThinkingLevel,
          });
          if (!compatibleUpdate) {
            throw new AiRuntimeInputError('RUNTIME_SELECTION_REQUIRED', 'runtimeSelection is required.');
          }
          runtimeUpdate = compatibleUpdate;
        }

        const result = await replaceSessionRuntimeSnapshot({ context, update: runtimeUpdate });
        await invalidateRuntime(sessionId, session.user.id);
        const updatedPi = await findOwnedPiSessionForRuntime({
          sessionId,
          userId: session.user.id,
          agentId: requestedAgentId,
        });
        return { busy: false as const, result, updatedPi };
      });
      if (runtimeChange.busy) {
        return NextResponse.json({ success: false, error: 'Model can only be changed while the agent is idle' }, { status: 409 });
      }
      const { result, updatedPi } = runtimeChange;
      await recordAuditEvent({
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        userId: session.user.id,
        agentId: requestedAgentId,
        sessionId,
        source: 'agent-runtime',
        eventType: 'user',
        entityType: 'pi_session',
        entityId: sessionId,
        action: 'pi_session_runtime.override',
        status: 'success',
        summary: 'AI runtime selection changed for a chat session.',
        metadata: {
          catalogRevision: result.snapshot.catalogRevision,
          policyRevision: result.snapshot.policyRevision,
          selectionSource: result.snapshot.selectionSource,
          selection: result.snapshot.selection,
        },
      });

      return NextResponse.json({
        success: true,
        session: updatedPi,
        runtime: result.snapshot,
        resolution: result.resolution,
      });
    }

    // Handle mark as read
    if (markAsRead) {
      console.log(`[API Sessions] PATCH markAsRead: sessionId=${sessionId}, userId=${session.user.id}`);
      const updated = await markPiSessionAsReadForUser({
        sessionId,
        userId: session.user.id,
        agentId: requestedAgentId,
      });

      if (!updated) {
        return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        session: updated,
      });
    }

    // Handle mark as unread
    if (markAsUnread) {
      const updated = await markPiSessionAsUnreadForUser({
        sessionId,
        userId: session.user.id,
        agentId: requestedAgentId,
      });

      if (!updated) {
        return NextResponse.json({ success: false, error: 'Session not found or has no messages' }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        session: updated,
      });
    }

    // Handle lastMessageAt update
    if (payload.lastMessageAt) {
      const piSession = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)));

      if (piSession.length > 0) {
        await db.update(piSessions)
          .set({ 
            lastMessageAt: new Date(payload.lastMessageAt), 
            updatedAt: new Date() 
          })
          .where(eq(piSessions.id, piSession[0].id));
        
        return NextResponse.json({
          success: true,
          session: { sessionId, lastMessageAt: new Date(payload.lastMessageAt) },
        });
      }

      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    // Handle rename
    if (!title) {
      return NextResponse.json({ success: false, error: 'Title required' }, { status: 400 });
    }

    // Try updating PI session first
    const updatedPi = await db
      .update(piSessions)
      .set({ title: title.slice(0, 120), titleGenerationState: 'manual', updatedAt: new Date() })
      .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)))
      .returning();

    if (updatedPi.length > 0) {
      await db.update(sessionChannelLinks)
        .set({ displayName: title.slice(0, 120), updatedAt: new Date() })
        .where(and(
          eq(sessionChannelLinks.sessionId, sessionId),
          eq(sessionChannelLinks.userId, session.user.id),
        ));
      return NextResponse.json({
        success: true,
        session: updatedPi[0],
      });
    }

    if (requestedAgentId !== DEFAULT_AGENT_ID) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    if (!(await legacyAiTablesExist())) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    // Fallback to legacy
    const updatedLegacy = await db
      .update(aiSessions)
      .set({ title: title.slice(0, 120) })
      .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, session.user.id)))
      .returning();

    if (updatedLegacy.length === 0) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      session: updatedLegacy[0],
    });
  } catch (error) {
    return sessionRuntimeErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const deleteAll = searchParams.get('all');
  const shouldDeleteAll = deleteAll === 'true' || deleteAll === '1';
  const olderThanDays = searchParams.get('olderThanDays');
  const shouldDeleteOlder = !!olderThanDays && !shouldDeleteAll && !sessionId;
  let requestedAgentId: string;

  try {
    requestedAgentId = normalizeSessionAgentId(searchParams.get('agentId'));
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
  }
  try {
    await requireAgentAccess(session.user.id, requestedAgentId, 'canUse');
  } catch {
    return NextResponse.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' }, { status: 403 });
  }

  if (!shouldDeleteAll && !sessionId && !shouldDeleteOlder) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
    const legacyTablesAvailable = await legacyAiTablesExist();

    if (shouldDeleteOlder) {
      const days = parseInt(olderThanDays!, 10);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Delete PI sessions older than cutoff (using lastMessageAt, falling back to createdAt)
      const olderPiSessions = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(
          and(
            eq(piSessions.userId, session.user.id),
            eq(piSessions.agentId, requestedAgentId),
            or(
              lt(piSessions.lastMessageAt, cutoff),
              and(isNull(piSessions.lastMessageAt), lt(piSessions.createdAt, cutoff))
            )
          )
        );

      let deletedCount = olderPiSessions.length;

      if (olderPiSessions.length > 0) {
        await deletePiSessionsByDbIds(olderPiSessions.map(s => s.id));
      }

      const olderAiSessions = requestedAgentId === DEFAULT_AGENT_ID && legacyTablesAvailable
        ? await db
            .select({ id: aiSessions.id })
            .from(aiSessions)
            .where(
              and(
                eq(aiSessions.userId, session.user.id),
                lt(aiSessions.createdAt, cutoff)
              )
            )
        : [];

      deletedCount += olderAiSessions.length;

      if (olderAiSessions.length > 0) {
        await db.delete(aiMessages).where(inArray(aiMessages.aiSessionDbId, olderAiSessions.map(s => s.id)));
        await db.delete(aiSessions).where(inArray(aiSessions.id, olderAiSessions.map(s => s.id)));
      }

      return NextResponse.json({
        success: true,
        deleted: 'older',
        count: deletedCount,
      });
    }

    if (shouldDeleteAll) {
      // Delete only the current user's sessions
      const userPiSessions = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(and(eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)));
      await deletePiSessionsByDbIds(userPiSessions.map(s => s.id));

      const userAiSessions = requestedAgentId === DEFAULT_AGENT_ID && legacyTablesAvailable
        ? await db
            .select({ id: aiSessions.id })
            .from(aiSessions)
            .where(eq(aiSessions.userId, session.user.id))
        : [];
      if (userAiSessions.length > 0) {
        await db.delete(aiMessages).where(inArray(aiMessages.aiSessionDbId, userAiSessions.map(s => s.id)));
      }
      if (requestedAgentId === DEFAULT_AGENT_ID && legacyTablesAvailable) {
        await db.delete(aiSessions).where(eq(aiSessions.userId, session.user.id));
      }

      return NextResponse.json({
        success: true,
        deleted: 'all',
      });
    }

    // Try deleting PI session (ownership enforced)
    const piSess = await db.select({ id: piSessions.id }).from(piSessions)
      .where(and(eq(piSessions.sessionId, sessionId!), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)));
    if (piSess.length > 0) {
      await deletePiSessionsByDbIds([piSess[0].id]);
      return NextResponse.json({ success: true, deleted: sessionId });
    }

    if (requestedAgentId !== DEFAULT_AGENT_ID) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    if (!legacyTablesAvailable) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    // Fallback to legacy (ownership enforced)
    const aiSess = await db.select({ id: aiSessions.id }).from(aiSessions)
      .where(and(eq(aiSessions.sessionId, sessionId!), eq(aiSessions.userId, session.user.id)));
    if (aiSess.length > 0) {
      await db.delete(aiMessages).where(eq(aiMessages.aiSessionDbId, aiSess[0].id));
      await db.delete(aiSessions).where(eq(aiSessions.id, aiSess[0].id));
      return NextResponse.json({ success: true, deleted: sessionId });
    }

    return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
  } catch (error) {
    console.error('[API] Failed to delete session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
