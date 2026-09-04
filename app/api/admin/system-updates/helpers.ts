import { NextResponse } from 'next/server';

import type { SystemUpdateReleaseChannel } from '@/cli/src/core/systemUpdateContract';
import { SystemUpdateBackendError } from '@/app/lib/system-updates/types';

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseSystemUpdateChannel(value: unknown): SystemUpdateReleaseChannel {
  if (value === undefined || value === null || value === '') return 'stable';
  if (value !== 'stable' && value !== 'beta') {
    throw new SystemUpdateBackendError(400, 'request_invalid', 'Update channel must be stable or beta.');
  }
  return value;
}

export function parseSystemUpdateOperationId(value: string): string {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new SystemUpdateBackendError(400, 'request_invalid', 'Update operation ID is invalid.');
  }
  return value;
}

export function parseEventCursor(value: string | null): number {
  const cursor = Number(value || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new SystemUpdateBackendError(400, 'request_invalid', 'Update event cursor is invalid.');
  }
  return cursor;
}

export function systemUpdateErrorResponse(error: unknown): NextResponse {
  const known = error instanceof SystemUpdateBackendError;
  const message = known ? error.message : 'System update request failed.';
  return NextResponse.json({
    success: false,
    error: {
      code: known ? error.code : 'system_update_failed',
      message: message.replace(/[\0\r\n]+/gu, ' ').slice(0, 2048),
    },
  }, {
    status: known ? error.statusCode : 500,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
