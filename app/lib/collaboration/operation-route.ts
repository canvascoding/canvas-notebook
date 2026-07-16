import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

export type CollaborationOperationBodyResult =
  | { idempotencyKey: string; response: null }
  | { idempotencyKey: null; response: NextResponse };

/**
 * Collaboration actions can be aborted while a tab is closing. Treat an
 * empty, truncated, or malformed body as a normal client error instead of
 * letting request.json() escape as an unhandled Next.js exception.
 */
export async function readCollaborationOperationIdempotencyKey(
  request: NextRequest,
): Promise<CollaborationOperationBodyResult> {
  let body: { idempotencyKey?: unknown };
  try {
    body = await request.json() as { idempotencyKey?: unknown };
  } catch {
    return {
      idempotencyKey: null,
      response: NextResponse.json(
        { success: false, error: 'A valid JSON body with idempotencyKey is required.' },
        { status: 400 },
      ),
    };
  }

  const idempotencyKey = typeof body.idempotencyKey === 'string'
    ? body.idempotencyKey.trim()
    : '';
  if (!idempotencyKey) {
    return {
      idempotencyKey: null,
      response: NextResponse.json(
        { success: false, error: 'idempotencyKey is required.' },
        { status: 400 },
      ),
    };
  }
  return { idempotencyKey, response: null };
}
