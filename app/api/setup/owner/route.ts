import { NextRequest, NextResponse } from 'next/server';

import { createInitialOwner, InitialOwnerSetupError } from '@/app/lib/auth-setup';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: 'setup-owner-post' });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => null);

  try {
    const owner = await createInitialOwner(body);
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
          : 500;

      return NextResponse.json(
        { success: false, code: error.code, error: error.message, field: error.field },
        { status },
      );
    }

    console.error('[setup-owner] Failed to create initial owner:', error);
    return NextResponse.json(
      { success: false, code: 'DATABASE_ERROR', error: 'Could not create initial owner.' },
      { status: 500 },
    );
  }
}
