import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';

import { MobileEmailError } from './email';

export const mobileEmailResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileEmailErrorResponse(error: unknown, context: string) {
  if (error instanceof MobileEmailError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: mobileEmailResponseHeaders },
    );
  }
  return jsonServerError(context, error, 'Email request failed.');
}
