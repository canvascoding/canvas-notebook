import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  acceptPiDelegationSteering,
  readAuthorizedPiDelegationSteeringReceipt,
  type PiDelegationSteeringReceipt,
} from '@/app/lib/pi/delegation-steering';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = { params: Promise<{ id: string }> };

function publicReceipt(receipt: PiDelegationSteeringReceipt) {
  return {
    id: receipt.id,
    delegationId: receipt.delegationId,
    status: receipt.status === 'claimed' ? 'accepted' : receipt.status,
    createdAt: receipt.createdAt.toISOString(),
    deliveredAt: receipt.deliveredAt?.toISOString() ?? null,
    missedAt: receipt.missedAt?.toISOString() ?? null,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'delegation-steering-get' });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  const sourceSessionId = request.nextUrl.searchParams.get('sourceSessionId')?.trim();
  const receiptId = request.nextUrl.searchParams.get('receiptId')?.trim();
  if (!id.trim() || !sourceSessionId || !receiptId) {
    return NextResponse.json({ success: false, error: 'Task, parent session, and receipt are required.' }, { status: 400 });
  }
  try {
    const receipt = await readAuthorizedPiDelegationSteeringReceipt({
      id: receiptId, delegationId: id.trim(), userId: session.user.id, sourceSessionId,
    });
    if (!receipt) return NextResponse.json({ success: false, error: 'Receipt not found.' }, { status: 404 });
    return NextResponse.json({ success: true, receipt: publicReceipt(receipt) });
  } catch {
    return NextResponse.json({ success: false, error: 'Receipt not found or inaccessible.' }, { status: 404 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'delegation-steering-post' });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  let parsed: unknown;
  try { parsed = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = parsed as { sourceSessionId?: unknown; message?: unknown; requestId?: unknown };
  const sourceSessionId = typeof body.sourceSessionId === 'string' ? body.sourceSessionId.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : randomUUID();
  if (!id.trim() || !sourceSessionId || !message || message.length > 4_000 || !requestId) {
    return NextResponse.json({ success: false, error: 'Invalid steering request.' }, { status: 400 });
  }
  try {
    const receipt = await acceptPiDelegationSteering({
      delegationId: id.trim(), userId: session.user.id, sourceSessionId,
      idempotencyKey: requestId, message,
    });
    return NextResponse.json({ success: true, receipt: publicReceipt(receipt) });
  } catch (error) {
    if (error instanceof Error && /no longer running|idempotency key|Steering message/u.test(error.message)) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: 'Task not found or inaccessible.' }, { status: 404 });
  }
}
