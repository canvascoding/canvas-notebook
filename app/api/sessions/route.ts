import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages, user, piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { and, desc, eq, inArray, lt, or, isNull, sql } from 'drizzle-orm';
import { type AgentId, isAgentId } from '@/app/lib/agents/catalog';
import { enforceAiSessionRetention } from '@/app/lib/agents/session-retention';
import { readAgentRuntimeConfig, providerIdToAgentId, readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID, getCanvasControlPlaneModels, getPiModels, OLLAMA_PROVIDER_ID, OPENAI_COMPATIBLE_PROVIDER_ID } from '@/app/lib/pi/model-resolver';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { getStatus, invalidateRuntime } from '@/app/lib/pi/runtime-service';
import { DEFAULT_AGENT_ID, WEB_CHANNEL_ID, normalizeStoredChannelId, webChannelSessionKey } from '@/app/lib/channels/constants';
import { ensureDefaultAgent } from '@/app/lib/channels/agents';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { deletePiSessionsByDbIds } from '@/app/lib/pi/session-deletion';

type CreateSessionPayload = {
  title?: string;
  model?: string;
  thinkingLevel?: string;
  agentId?: string;
  channelId?: string;
  channelSessionKey?: string;
};

type RenameSessionPayload = {
  sessionId?: string;
  agentId?: string;
  title?: string;
  markAsRead?: boolean;
  markAllAsRead?: boolean;
  lastMessageAt?: string;
  model?: string;
  thinkingLevel?: string;
};

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function resolveRequestedModel(value: unknown): AgentId | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return isAgentId(normalized) ? normalized : null;
}

function buildSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function normalizeThinkingLevel(value: unknown): PiThinkingLevel | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

function getProviderCustomModel(piConfig: Awaited<ReturnType<typeof readPiRuntimeConfig>>, provider: string): string | undefined {
  const providerConfig = piConfig.providers[provider];
  if (provider === OLLAMA_PROVIDER_ID && providerConfig?.ollamaModelSource === 'custom') {
    return providerConfig.ollamaCustomModel?.trim() || undefined;
  }
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID && providerConfig?.openaiCompatibleModelSource === 'custom') {
    return providerConfig.openaiCompatibleCustomModel?.trim() || undefined;
  }
  return undefined;
}

async function isValidProviderModel(provider: string, model: string): Promise<boolean> {
  const piConfig = await readPiRuntimeConfig();
  const customModel = getProviderCustomModel(piConfig, provider);
  const models = provider === CANVAS_CONTROL_PLANE_PROVIDER_ID
    ? await getCanvasControlPlaneModels()
    : getPiModels(provider, customModel);
  return models.some((candidate) => candidate.id === model);
}

async function syncSessionModelToPiConfig(
  provider: string,
  model: string | null,
  thinkingLevel: PiThinkingLevel | null,
) {
  const piConfig = await readPiRuntimeConfig();
  const providerConfig = piConfig.providers[provider];
  if (!providerConfig || (!model && !thinkingLevel)) {
    return;
  }

  await writePiRuntimeConfig({
    ...piConfig,
    activeProvider: provider,
    providers: {
      ...piConfig.providers,
      [provider]: {
        ...providerConfig,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
      },
    },
  });
}

async function resolveDefaultModel(): Promise<AgentId> {
  const config = await readAgentRuntimeConfig();
  return providerIdToAgentId(config.provider.id);
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
  const includeAllAgentSessions = rawAgentIdFilter === 'all';
  let agentIdFilter: string | null;

  try {
    agentIdFilter = includeAllAgentSessions ? null : normalizeSessionAgentId(rawAgentIdFilter);
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
  }

  try {
    const cutoff = olderThanDays ? new Date(Date.now() - parseInt(olderThanDays, 10) * 24 * 60 * 60 * 1000) : null;

    if (countOnly && cutoff) {
      const piCutoffCondition = cutoff
        ? or(lt(piSessions.lastMessageAt, cutoff), and(isNull(piSessions.lastMessageAt), lt(piSessions.createdAt, cutoff)))
        : undefined;

      const piOlderCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(piSessions)
        .where(
          includeAllAgentSessions
            ? and(eq(piSessions.userId, session.user.id), piCutoffCondition!)
            : and(eq(piSessions.userId, session.user.id), eq(piSessions.agentId, agentIdFilter!), piCutoffCondition!)
        );

      const includeLegacyCount = includeAllAgentSessions || agentIdFilter === DEFAULT_AGENT_ID;
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

    const whereClause = legacyModelFilter
      ? and(eq(aiSessions.model, legacyModelFilter), eq(aiSessions.userId, session.user.id))
      : eq(aiSessions.userId, session.user.id);
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
    const includeLegacySessions = (includeAllAgentSessions || agentIdFilter === DEFAULT_AGENT_ID) && (!normalizedChannelFilter || normalizedChannelFilter === WEB_CHANNEL_ID);
    const piBaseWhere = includeAllAgentSessions
      ? eq(piSessions.userId, session.user.id)
      : and(eq(piSessions.userId, session.user.id), eq(piSessions.agentId, agentIdFilter!));

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
          agentId: piSessions.agentId,
          model: piSessions.model,
          thinkingLevel: piSessions.thinkingLevel,
          provider: piSessions.provider,
          createdAt: piSessions.createdAt,
          lastMessageAt: piSessions.lastMessageAt,
          lastViewedAt: piSessions.lastViewedAt,
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
        .orderBy(desc(piSessions.createdAt))
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
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const mappedSessions = combined.map((item) => {
      const hasUnread = item.engine === 'pi' && hasUnreadAssistantResponse(item.lastMessageAt, item.lastViewedAt);
      if (hasUnread) {
        console.log(`[API Sessions] Unread session: sessionId=${item.sessionId}, lastMessageAt=${item.lastMessageAt?.toISOString()}, lastViewedAt=${item.lastViewedAt?.toISOString()}`);
      }
      return {
        id: item.id,
        sessionId: item.sessionId,
        userId: item.userId,
        title: item.title,
        agentId: item.agentId,
        model: item.model,
        provider: 'provider' in item ? item.provider : null,
        thinkingLevel: 'thinkingLevel' in item ? item.thinkingLevel : null,
        engine: item.engine,
        createdAt: item.createdAt,
        lastMessageAt: item.lastMessageAt,
        lastViewedAt: item.lastViewedAt,
        channelId: item.channelId,
        hasUnread,
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
    const payload = (await request.json().catch(() => ({}))) as CreateSessionPayload;
    const sessionId = buildSessionId();
    const title = normalizeTitle(payload.title, DEFAULT_SESSION_TITLE);

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
      const effectiveConfig = await resolveAgentRuntimeConfig(requestedAgentId);
      const provider = effectiveConfig.activeProvider;
      const providerConfig = effectiveConfig.providerConfig;

      if (requestedModel && !(await isValidProviderModel(provider, requestedModel))) {
        return NextResponse.json({ success: false, error: 'Invalid model for active provider' }, { status: 400 });
      }

      const model = requestedModel || providerConfig?.model || 'unknown';
      const thinkingLevel = requestedThinkingLevel || providerConfig?.thinking || 'off';
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : 'app';
      const normalizedChannelId = normalizeStoredChannelId(channelId);
      const channelSessionKey = typeof payload.channelSessionKey === 'string'
        ? payload.channelSessionKey
        : normalizedChannelId === WEB_CHANNEL_ID
          ? webChannelSessionKey(session.user.id)
          : null;

      const inserted = await db
        .insert(piSessions)
        .values({
          sessionId,
          userId: session.user.id,
          agentId: requestedAgentId,
          provider,
          model,
          thinkingLevel,
          title,
          channelId: 'app',
          channelSessionKey: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      await ensureSessionChannelLink({
        sessionId,
        userId: session.user.id,
        channelId: normalizedChannelId,
        channelSessionKey: channelSessionKey || webChannelSessionKey(session.user.id),
        displayName: title,
        isPrimary: normalizedChannelId === WEB_CHANNEL_ID,
      });

      return NextResponse.json({
        success: true,
        session: {
          ...inserted[0],
          engine: 'pi',
          creator: {
            name: session.user.name || null,
            email: session.user.email || null,
          },
        },
      });
    }

    const requestedModel = resolveRequestedModel(payload.agentId ?? payload.model);
    const model = requestedModel ?? (await resolveDefaultModel());

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
    console.error('[API] Failed to create session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as RenameSessionPayload;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const markAsRead = typeof payload.markAsRead === 'boolean' ? payload.markAsRead : false;
    const markAllAsRead = typeof payload.markAllAsRead === 'boolean' ? payload.markAllAsRead : false;
    const requestedModel = normalizeOptionalString(payload.model);
    const requestedThinkingLevel = normalizeThinkingLevel(payload.thinkingLevel);
    let requestedAgentId: string;

    try {
      requestedAgentId = normalizeSessionAgentId(payload.agentId);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
    }

    if (payload.thinkingLevel !== undefined && !requestedThinkingLevel) {
      return NextResponse.json({ success: false, error: 'Invalid thinking level' }, { status: 400 });
    }

    // Handle mark all as read
    if (markAllAsRead && !sessionId) {
      const now = new Date();
      await db
        .update(piSessions)
        .set({ lastViewedAt: now, updatedAt: now })
        .where(and(eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)));

      return NextResponse.json({
        success: true,
        lastViewedAt: now.toISOString(),
      });
    }

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    if (requestedModel || requestedThinkingLevel) {
      const piSession = await db.query.piSessions.findFirst({
        where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)),
      });

      if (!piSession) {
        return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      if (requestedModel && !(await isValidProviderModel(piSession.provider, requestedModel))) {
        return NextResponse.json({ success: false, error: 'Invalid model for session provider' }, { status: 400 });
      }

      const runtimeStatus = await getStatus(sessionId, session.user.id);
      if (runtimeStatus && runtimeStatus.phase !== 'idle') {
        return NextResponse.json({ success: false, error: 'Model can only be changed while the agent is idle' }, { status: 409 });
      }

      const updateValues = {
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
        updatedAt: new Date(),
      };
      const updatedPi = await db
        .update(piSessions)
        .set(updateValues)
        .where(eq(piSessions.id, piSession.id))
        .returning();

      if (piSession.agentId === DEFAULT_AGENT_ID) {
        await syncSessionModelToPiConfig(piSession.provider, requestedModel, requestedThinkingLevel);
      }
      await invalidateRuntime(sessionId, session.user.id);

      return NextResponse.json({
        success: true,
        session: updatedPi[0],
      });
    }

    // Handle mark as read
    if (markAsRead) {
      console.log(`[API Sessions] PATCH markAsRead: sessionId=${sessionId}, userId=${session.user.id}`);
      const piSession = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)));

      if (piSession.length > 0) {
        const now = new Date();
        console.log(`[API Sessions] PATCH markAsRead: setting lastViewedAt=${now.toISOString()} for dbId=${piSession[0].id}`);
        await db.update(piSessions)
          .set({ lastViewedAt: now, updatedAt: now })
          .where(eq(piSessions.id, piSession[0].id));
        
        return NextResponse.json({
          success: true,
          session: { sessionId, lastViewedAt: new Date() },
        });
      }

      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
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
      .set({ title: title.slice(0, 120), updatedAt: new Date() })
      .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, requestedAgentId)))
      .returning();

    if (updatedPi.length > 0) {
      return NextResponse.json({
        success: true,
        session: updatedPi[0],
      });
    }

    if (requestedAgentId !== DEFAULT_AGENT_ID) {
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
    console.error('[API] Failed to rename session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
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

  if (!shouldDeleteAll && !sessionId && !shouldDeleteOlder) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
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

      const olderAiSessions = requestedAgentId === DEFAULT_AGENT_ID
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

      const userAiSessions = requestedAgentId === DEFAULT_AGENT_ID
        ? await db
            .select({ id: aiSessions.id })
            .from(aiSessions)
            .where(eq(aiSessions.userId, session.user.id))
        : [];
      if (userAiSessions.length > 0) {
        await db.delete(aiMessages).where(inArray(aiMessages.aiSessionDbId, userAiSessions.map(s => s.id)));
      }
      if (requestedAgentId === DEFAULT_AGENT_ID) {
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
