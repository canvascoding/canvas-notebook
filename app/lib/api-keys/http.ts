import 'server-only';

import { NextResponse } from 'next/server';
import { ApiKeyAccessError } from './contracts';

/** Public document adapters expose only a code and bounded retry advice. */
export function apiKeyDocumentErrorResponse(error: unknown, headers: Record<string, string>): NextResponse | null {
  if (!(error instanceof ApiKeyAccessError)) return null;
  const retryAfter = Number(error.details.retryAfter);
  return NextResponse.json({ apiVersion: 1, success: false, code: error.code }, { status: error.status,
    headers: { ...headers, ...(Number.isFinite(retryAfter) && retryAfter > 0
      ? { 'Retry-After': String(Math.min(60, Math.max(1, Math.ceil(retryAfter)))) } : {}) } });
}
