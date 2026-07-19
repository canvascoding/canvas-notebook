import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';

import { MobileFilesError } from './files';

export const mobileFilesResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileFilesErrorResponse(error: unknown, logContext: string) {
  if (error instanceof MobileFilesError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status, headers: mobileFilesResponseHeaders },
    );
  }
  return jsonServerError(logContext, error, 'Files request failed');
}
