import 'server-only';

import { NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { resourceRequestActor, resourceResponse } from '@/app/api/capabilities/resources/http';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError, isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';

export { resourceRequestActor as packageRequestActor, resourceResponse as packageResponse };

export async function packageRequestJson(request: Request, fileWrite = false): Promise<unknown> {
  const limit = fileWrite ? Math.ceil(CAPABILITY_PACKAGE_LIMITS.maxFileBytes * 4 / 3) + 16 * 1024 : 16 * 1024;
  const parsed = await readBoundedJson(request, limit);
  if (parsed.response) throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', 'The package request exceeds its transport limit.', 413);
  if (parsed.body === null) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'A valid JSON request body is required.');
  return parsed.body;
}

export function packageResponseError(error: unknown): NextResponse {
  if (isCapabilityPackageError(error) || error instanceof CapabilityResourceError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return NextResponse.json({ success: false, code: 'PACKAGE_REQUEST_INVALID', error: 'The package request is invalid.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  console.error('[CapabilityPackages] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError',
    ...(typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code) ? { databaseCode: code } : {}) });
  return NextResponse.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE', error: 'Package management is currently unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
