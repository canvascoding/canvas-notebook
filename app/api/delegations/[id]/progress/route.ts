import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { piMessages } from '@/app/lib/db/schema';
import { readAuthorizedPiDelegationProgress } from '@/app/lib/pi/delegation-progress';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = { params: Promise<{ id: string }> };
const MAX_TAIL_MESSAGES = 24;

function boundedInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, maximum) : null;
}

function safeToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : null;
}

function transcriptPreview(content: string): { role: string; text: string | null; toolNames: string[]; isError: boolean } | null {
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    message = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return null;
  const toolNames = new Set<string>();
  if (role === 'toolResult') {
    const name = safeToolName(message.toolName);
    if (name) toolNames.add(name);
  }
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (block.type === 'toolCall') {
      const name = safeToolName(block.name);
      if (name) toolNames.add(name);
    }
  }
  // Full text is available only from the separately authorized messages API.
  // Progress polling never copies prompts, model output, or tool results.
  return { role, text: null, toolNames: [...toolNames], isError: message.isError === true || message.stopReason === 'error' };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'delegation-progress-get' });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  const sourceSessionId = request.nextUrl.searchParams.get('sourceSessionId')?.trim() || '';
  const afterRevision = boundedInteger(request.nextUrl.searchParams.get('afterRevision'), 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(request.nextUrl.searchParams.get('limit'), 50, 100);
  const tailLimit = boundedInteger(request.nextUrl.searchParams.get('tailLimit'), 0, MAX_TAIL_MESSAGES);
  if (!id.trim() || !sourceSessionId || afterRevision === null || limit === null || tailLimit === null) {
    return NextResponse.json({ success: false, error: 'Invalid progress request.' }, { status: 400 });
  }

  try {
    const { delegation, workerSession, events, leaseState } = await readAuthorizedPiDelegationProgress({
      delegationId: id.trim(),
      userId: session.user.id,
      sourceSessionId,
      afterRevision,
      limit,
    });
    const tailRows = workerSession && tailLimit > 0
      ? await db.select({ sequence: piMessages.sequence, timestamp: piMessages.timestamp, content: piMessages.content })
        .from(piMessages)
        .where(eq(piMessages.piSessionDbId, workerSession.id))
        .orderBy(desc(piMessages.sequence))
        .limit(tailLimit)
      : [];
    const transcript = tailRows.reverse().flatMap((row) => {
      const preview = transcriptPreview(row.content);
      return preview ? [{ sequence: row.sequence, timestamp: row.timestamp, ...preview }] : [];
    });
    return NextResponse.json({
      success: true,
      delegation: {
        id: delegation.id,
        workerSessionId: delegation.workerSessionId,
        workerType: delegation.workerType,
        targetAgentId: delegation.targetAgentId,
        status: delegation.status,
        displayStatus: delegation.status === 'running' && leaseState !== 'active'
          ? leaseState === 'expired' ? 'interrupted' : 'unknown'
          : delegation.status,
        leaseState,
        revision: delegation.progressRevision,
        createdAt: delegation.createdAt.toISOString(),
        startedAt: delegation.startedAt?.toISOString() ?? null,
        completedAt: delegation.completedAt?.toISOString() ?? null,
      },
      events: events.map((event) => ({
        revision: event.revision,
        kind: event.kind,
        preview: event.preview,
        createdAt: event.createdAt.toISOString(),
      })),
      transcript,
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Delegation not found or inaccessible.' }, { status: 404 });
  }
}
