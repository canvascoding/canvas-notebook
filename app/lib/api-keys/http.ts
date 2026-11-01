import 'server-only';

import { NextResponse } from 'next/server';
import { apiKeyDocumentFailureV1 } from './error-result';

/** Public document adapters expose only a code and bounded retry advice. */
export function apiKeyDocumentErrorResponse(error: unknown, headers: Record<string, string>): NextResponse | null {
  const failure = apiKeyDocumentFailureV1(error);
  if (!failure) return null;
  return NextResponse.json(failure.body, { status: failure.status,
    headers: { ...headers, ...(failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {}) } });
}
