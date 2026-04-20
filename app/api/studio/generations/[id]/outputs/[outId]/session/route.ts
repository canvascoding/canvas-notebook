import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { piSessions, studioGenerationOutputs, studioGenerations } from '@/app/lib/db/schema';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';

function buildSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; outId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id, outId } = await params;

  try {
    const [generation] = await db
      .select()
      .from(studioGenerations)
      .where(and(eq(studioGenerations.id, id), eq(studioGenerations.userId, session.user.id)))
      .limit(1);

    if (!generation) {
      return NextResponse.json({ success: false, error: 'Generation not found' }, { status: 404 });
    }

    const [output] = await db
      .select()
      .from(studioGenerationOutputs)
      .where(and(eq(studioGenerationOutputs.id, outId), eq(studioGenerationOutputs.generationId, id)))
      .limit(1);

    if (!output) {
      return NextResponse.json({ success: false, error: 'Output not found' }, { status: 404 });
    }

    if (output.piSessionId) {
      return NextResponse.json({ success: true, sessionId: output.piSessionId, created: false });
    }

    const sessionId = buildSessionId();
    const piConfig = await readPiRuntimeConfig();
    const provider = piConfig.activeProvider;
    const model = piConfig.providers[provider]?.model || 'unknown';
    const titleBase = generation.rawPrompt || generation.prompt || DEFAULT_SESSION_TITLE;
    const title = `Studio: ${titleBase.slice(0, 80)}`;
    const now = new Date();

    await db.insert(piSessions).values({
      sessionId,
      userId: session.user.id,
      provider,
      model,
      title,
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(studioGenerationOutputs)
      .set({ piSessionId: sessionId })
      .where(eq(studioGenerationOutputs.id, outId));

    return NextResponse.json({ success: true, sessionId, created: true });
  } catch (error) {
    console.error('[Studio Output Session] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create session' }, { status: 500 });
  }
}
