import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { session, user } from '@/app/lib/db/schema';

const MAX_EMAIL_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function normalizePassword(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const currentSession = await auth.api.getSession({ headers: request.headers });
    if (!currentSession) {
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    const payload = await request.json().catch(() => null) as {
      newEmail?: unknown;
      currentPassword?: unknown;
    } | null;
    const newEmail = normalizeEmail(payload?.newEmail);
    const currentPassword = normalizePassword(payload?.currentPassword);

    if (!newEmail || !currentPassword) {
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'A valid email address and your current password are required.', requestId },
        { status: 400 },
      );
    }

    if (newEmail === currentSession.user.email.toLowerCase()) {
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'The new email address must be different from the current one.', requestId },
        { status: 400 },
      );
    }

    try {
      await auth.api.verifyPassword({
        headers: request.headers,
        body: { password: currentPassword },
      });
    } catch {
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'The current password is incorrect.', requestId },
        { status: 400 },
      );
    }

    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${newEmail}`)
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].id !== currentSession.user.id) {
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'This email address is already in use.', requestId },
        { status: 409 },
      );
    }

    await db
      .update(user)
      .set({ email: newEmail, updatedAt: new Date() })
      .where(eq(user.id, currentSession.user.id));
    await db.delete(session).where(eq(session.userId, currentSession.user.id));

    await recordAuditEvent({
      userId: currentSession.user.id,
      sessionId: currentSession.session.id,
      source: 'account',
      eventType: 'account',
      entityType: 'user',
      entityId: currentSession.user.id,
      action: 'account.email_updated',
      status: 'success',
      summary: 'User updated their login email address.',
      metadata: { requestId },
    });

    return jsonWithRequestId(requestId, { success: true, requestId });
  } catch (error) {
    console.error('[account/email] Failed to update account email:', { requestId, error });
    return jsonWithRequestId(
      requestId,
      { success: false, error: 'Failed to update the email address.', requestId },
      { status: 500 },
    );
  }
}
