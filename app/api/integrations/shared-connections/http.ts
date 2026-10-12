import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resourceRequestActor, resourceRequestJson, resourceResponse } from '@/app/api/capabilities/resources/http';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';

export { resourceRequestActor as connectionRequestActor, resourceRequestJson as connectionRequestJson, resourceResponse as connectionResponse };

export function connectionResponseError(error: unknown): NextResponse {
  if (isIntegrationConnectionError(error) || error instanceof CapabilityResourceError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  if (error instanceof z.ZodError) return NextResponse.json({ success: false, code: 'invalid_request', error: 'The connection request is invalid.' }, { status: 400 });
  const diagnostic = error && typeof error === 'object' ? error as { code?: unknown; table?: unknown; constraint?: unknown } : {};
  const identifier = (value: unknown) => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,119}$/u.test(value) ? value : undefined;
  console.error('[SharedConnections] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError',
    ...(typeof diagnostic.code === 'string' && /^[A-Z0-9]{5}$/u.test(diagnostic.code) ? { databaseCode: diagnostic.code } : {}),
    table: identifier(diagnostic.table), constraint: identifier(diagnostic.constraint) });
  return NextResponse.json({ success: false, code: 'connection_unavailable', error: 'Connection management is currently unavailable.' }, { status: 503 });
}
