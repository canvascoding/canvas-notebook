import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages, user } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { desc, eq, inArray } from 'drizzle-orm';
import { type AgentId, isAgentId } from '@/app/lib/agents/catalog';
import { enforceAiSessionRetention } from '@/app/lib/agents/session-retention';
import { readAgentRuntimeConfig, providerIdToAgentId } from '@/app/lib/agents/storage';

type CreateSessionPayload = {
  title?: string;
  model?: string;
  agentId?: string;
};

type RenameSessionPayload = {
  sessionId?: string;
  title?: string;
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

  const { searchParams } = new URL(request.url);
  const legacyModelFilter = resolveRequestedModel(searchParams.get('model'));

  try {
    const whereClause = legacyModelFilter ? eq(aiSessions.model, legacyModelFilter) : undefined;
    const sessions = await db
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
      .limit(200);

    return NextResponse.json({
      success: true,
      sessions: sessions.map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        userId: item.userId,
        title: item.title,
        model: item.model,
        createdAt: item.createdAt,
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

  try {
    const payload = (await request.json().catch(() => ({}))) as CreateSessionPayload;
    const requestedModel = resolveRequestedModel(payload.agentId ?? payload.model);
    const model = requestedModel ?? (await resolveDefaultModel());
    const sessionId = buildSessionId();
    const title = normalizeTitle(payload.title, 'New session');

    const inserted = await db
      .insert(aiSessions)
      .values({
        sessionId,
        userId: session.user.id,
        model,
        title,
        createdAt: new Date(),
      })
      .returning({
        id: aiSessions.id,
        sessionId: aiSessions.sessionId,
        userId: aiSessions.userId,
        model: aiSessions.model,
        title: aiSessions.title,
        createdAt: aiSessions.createdAt,
      });

    const created = inserted[0];
    await enforceAiSessionRetention();

    return NextResponse.json({
      success: true,
      session: {
        ...created,
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

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    if (!title) {
      return NextResponse.json({ success: false, error: 'Title required' }, { status: 400 });
    }

    const updated = await db
      .update(aiSessions)
      .set({ title: title.slice(0, 120) })
      .where(eq(aiSessions.sessionId, sessionId))
      .returning({
        id: aiSessions.id,
        sessionId: aiSessions.sessionId,
        title: aiSessions.title,
      });

    if (updated.length === 0) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      session: updated[0],
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

  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
    const dbSessions = await db
      .select({ id: aiSessions.id })
      .from(aiSessions)
      .where(eq(aiSessions.sessionId, sessionId));

    if (dbSessions.length === 0) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    const sessionDbIds = dbSessions.map((item) => item.id);
    const deletedMessages = await db
      .delete(aiMessages)
      .where(inArray(aiMessages.aiSessionDbId, sessionDbIds))
      .returning({ id: aiMessages.id });
    const deletedSessions = await db
      .delete(aiSessions)
      .where(eq(aiSessions.sessionId, sessionId))
      .returning({ id: aiSessions.id });

    return NextResponse.json({
      success: true,
      deleted: {
        sessions: deletedSessions.length,
        messages: deletedMessages.length,
      },
    });
  } catch (error) {
    console.error('[API] Failed to delete session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
