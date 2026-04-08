import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages, user, piSessions, piMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type AgentId, isAgentId } from '@/app/lib/agents/catalog';
import { enforceAiSessionRetention } from '@/app/lib/agents/session-retention';
import { readAgentRuntimeConfig, providerIdToAgentId, readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';

type CreateSessionPayload = {
  title?: string;
  model?: string;
  agentId?: string;
};

type RenameSessionPayload = {
  sessionId?: string;
  title?: string;
  markAsRead?: boolean;
  lastMessageAt?: string;
};

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

  try {
    const whereClause = legacyModelFilter
      ? and(eq(aiSessions.model, legacyModelFilter), eq(aiSessions.userId, session.user.id))
      : eq(aiSessions.userId, session.user.id);

    const [legacySessions, newPiSessions] = await Promise.all([
      db
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
        .limit(100),
      db
        .select({
          id: piSessions.id,
          sessionId: piSessions.sessionId,
          userId: piSessions.userId,
          title: piSessions.title,
          model: piSessions.model,
          provider: piSessions.provider,
          createdAt: piSessions.createdAt,
          lastMessageAt: piSessions.lastMessageAt,
          lastViewedAt: piSessions.lastViewedAt,
          creatorName: user.name,
          creatorEmail: user.email,
        })
        .from(piSessions)
        .leftJoin(user, eq(piSessions.userId, user.id))
        .where(eq(piSessions.userId, session.user.id))
        .orderBy(desc(piSessions.createdAt))
        .limit(100)
    ]);

    const combined = [
      ...legacySessions.map(s => ({ ...s, engine: 'legacy' as const, lastMessageAt: null as Date | null, lastViewedAt: null as Date | null })),
      ...newPiSessions.map(s => ({ 
        ...s, 
        engine: 'pi' as const,
        lastMessageAt: s.lastMessageAt,
        lastViewedAt: s.lastViewedAt
      }))
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json({
      success: true,
      sessions: combined.map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        userId: item.userId,
        title: item.title,
        model: item.model,
        engine: item.engine,
        createdAt: item.createdAt,
        lastMessageAt: item.lastMessageAt,
        lastViewedAt: item.lastViewedAt,
        hasUnread: item.engine === 'pi' && item.lastMessageAt !== null && item.lastViewedAt !== null && item.lastMessageAt.getTime() > item.lastViewedAt.getTime(),
        creator: {
          name: item.creatorName || null,
          email: item.creatorEmail || null,
        },
      })),
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
      const piConfig = await readPiRuntimeConfig();
      const provider = piConfig.activeProvider;
      const model = piConfig.providers[provider]?.model || 'unknown';

      const inserted = await db
        .insert(piSessions)
        .values({
          sessionId,
          userId: session.user.id,
          provider,
          model,
          title,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

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

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    // Handle mark as read
    if (markAsRead) {
      const piSession = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id)));

      if (piSession.length > 0) {
        await db.update(piSessions)
          .set({ lastViewedAt: new Date(), updatedAt: new Date() })
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
        .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id)));

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
      .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id)))
      .returning();

    if (updatedPi.length > 0) {
      return NextResponse.json({
        success: true,
        session: updatedPi[0],
      });
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

  if (!shouldDeleteAll && !sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
    if (shouldDeleteAll) {
      // Delete only the current user's sessions
      const userPiSessions = await db
        .select({ id: piSessions.id })
        .from(piSessions)
        .where(eq(piSessions.userId, session.user.id));
      if (userPiSessions.length > 0) {
        await db.delete(piMessages).where(inArray(piMessages.piSessionDbId, userPiSessions.map(s => s.id)));
      }
      await db.delete(piSessions).where(eq(piSessions.userId, session.user.id));

      const userAiSessions = await db
        .select({ id: aiSessions.id })
        .from(aiSessions)
        .where(eq(aiSessions.userId, session.user.id));
      if (userAiSessions.length > 0) {
        await db.delete(aiMessages).where(inArray(aiMessages.aiSessionDbId, userAiSessions.map(s => s.id)));
      }
      await db.delete(aiSessions).where(eq(aiSessions.userId, session.user.id));

      return NextResponse.json({
        success: true,
        deleted: 'all',
      });
    }

    // Try deleting PI session (ownership enforced)
    const piSess = await db.select({ id: piSessions.id }).from(piSessions)
      .where(and(eq(piSessions.sessionId, sessionId!), eq(piSessions.userId, session.user.id)));
    if (piSess.length > 0) {
      await db.delete(piMessages).where(eq(piMessages.piSessionDbId, piSess[0].id));
      await db.delete(piSessions).where(eq(piSessions.id, piSess[0].id));
      return NextResponse.json({ success: true, deleted: sessionId });
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
