import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { createInitialOwner, InitialOwnerSetupError } from '@/app/lib/auth-setup';
import { writeOnboardingLog } from '@/app/lib/onboarding/logging';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: 'setup-owner-post' });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => null);

  try {
    const owner = await createInitialOwner(body);
    await writeOnboardingLog('info', 'setup-owner.created', {
      userId: owner.id,
      email: owner.email,
    });
    await recordAuditEvent({
      userId: owner.id,
      source: 'auth',
      eventType: 'admin',
      entityType: 'user',
      entityId: owner.id,
      action: 'owner_setup.create',
      status: 'success',
      summary: 'Initial owner account created.',
      metadata: {
        email: owner.email,
      },
    });
    return NextResponse.json({
      success: true,
      user: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
      },
    });
  } catch (error) {
    if (error instanceof InitialOwnerSetupError) {
      const status = error.code === 'ALREADY_CONFIGURED'
        ? 409
        : error.code === 'INVALID_INPUT'
          ? 400
          : error.code === 'DATABASE_PROVIDER_BLOCKED'
            ? 503
          : 500;

      await writeOnboardingLog('warn', 'setup-owner.rejected', {
        code: error.code,
        field: error.field,
        status,
      });
      return NextResponse.json(
        { success: false, code: error.code, error: error.message, field: error.field },
        { status },
      );
    }

    console.error('[setup-owner] Failed to create initial owner:', error);
    await writeOnboardingLog('error', 'setup-owner.failed', { error });
    return NextResponse.json(
      { success: false, code: 'DATABASE_ERROR', error: 'Could not create initial owner.' },
      { status: 500 },
    );
  }
}
