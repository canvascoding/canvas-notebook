import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';

import { MobileInboxError } from './inbox';

export const mobileInboxResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileInboxErrorResponse(error: unknown, context: string) {
  if (error instanceof MobileInboxError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: mobileInboxResponseHeaders },
    );
  }
  return jsonServerError(context, error, 'Inbox request failed.');
}
