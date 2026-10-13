import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';

export async function readExcalidrawOperationApproval(request: NextRequest): Promise<
  | { idempotencyKey: string; expectedCasVersion: number; response: null }
  | { idempotencyKey: null; expectedCasVersion: null; response: NextResponse }
> {
  const parsed = await readBoundedJson(request, 4 * 1024);
  if (parsed.response) return { idempotencyKey: null, expectedCasVersion: null, response: parsed.response };
  const invalid = (message: string) => ({ idempotencyKey: null, expectedCasVersion: null,
    response: NextResponse.json({ success: false, code: 'INVALID_EXCALIDRAW_APPROVAL', error: message }, { status: 400 }) });
  if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
    return invalid('A JSON object with idempotencyKey and expectedCasVersion is required. Reload the current review before accepting.');
  }
  const body = parsed.body as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'expectedCasVersion' || keys[1] !== 'idempotencyKey') {
    return invalid('Only idempotencyKey and the displayed expectedCasVersion are accepted. Reload the current review before accepting.');
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!idempotencyKey || idempotencyKey.length > 200) return invalid('idempotencyKey must contain 1–200 characters.');
  if (!Number.isSafeInteger(body.expectedCasVersion) || Number(body.expectedCasVersion) < 0) {
    return invalid('The displayed expectedCasVersion is required. Reload the current review before accepting.');
  }
  return { idempotencyKey, expectedCasVersion: Number(body.expectedCasVersion), response: null };
}
