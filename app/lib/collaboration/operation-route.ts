import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';

export type CollaborationOperationApprovalBodyResult =
  | { idempotencyKey: string; proposalVersion: string; response: null }
  | { idempotencyKey: null; proposalVersion: null; response: NextResponse };

/** Approval is bound to the exact displayed proposal; older clients must reload. */
export async function readCollaborationOperationApproval(request: NextRequest): Promise<CollaborationOperationApprovalBodyResult> {
  const parsed = await readBoundedJson(request, 4 * 1024);
  if (parsed.response) return { idempotencyKey: null, proposalVersion: null, response: parsed.response };
  const invalid = (error: string): CollaborationOperationApprovalBodyResult => ({
    idempotencyKey: null, proposalVersion: null,
    response: NextResponse.json({ success: false, error }, { status: 400 }),
  });
  if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
    return invalid('A JSON object with idempotencyKey and proposalVersion is required. Reload the proposal before approving.');
  }
  const body = parsed.body as { idempotencyKey?: unknown; proposalVersion?: unknown };
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!idempotencyKey || idempotencyKey.length > 200) return invalid('idempotencyKey must contain 1–200 characters.');
  if (typeof body.proposalVersion !== 'string' || !/^v1\.[a-f0-9]{64}$/u.test(body.proposalVersion)) {
    return invalid('A valid proposalVersion is required. Reload the current proposal before approving.');
  }
  return { idempotencyKey, proposalVersion: body.proposalVersion, response: null };
}

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
