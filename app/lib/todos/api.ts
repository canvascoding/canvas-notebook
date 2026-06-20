import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { TodoStoreError } from './store';

export async function requireTodoSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

export function applyTodoRateLimit(request: NextRequest, keyPrefix: string, limit = 60, windowMs = 60_000) {
  return rateLimit(request, {
    limit,
    windowMs,
    keyPrefix,
  });
}

export function todoErrorResponse(error: unknown, fallback: string) {
  if (error instanceof TodoStoreError) {
    const status = error.code === 'TODO_NOT_FOUND' || error.code === 'CATEGORY_NOT_FOUND'
      ? 404
      : error.code === 'ORGANIZATION_ACCESS_DENIED'
        ? 403
        : 400;
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status });
  }

  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );
}

export function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TodoStoreError('Invalid date', 'INVALID_INPUT');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TodoStoreError('Invalid date', 'INVALID_INPUT');
  }
  return date;
}
