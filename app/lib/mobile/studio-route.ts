import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

import { MobileStudioError } from './studio';

export const mobileStudioResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileStudioErrorResponse(error: unknown, context: string) {
  if (error instanceof MobileStudioError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status, headers: mobileStudioResponseHeaders },
    );
  }
  if (error instanceof StudioServiceError) {
    const status = error.code === 'NOT_FOUND' ? 404
      : error.code === 'FORBIDDEN' ? 403
        : error.code === 'RATE_LIMIT' ? 429
          : 400;
    return NextResponse.json(
      { success: false, error: error.userMessage, code: error.code },
      { status, headers: mobileStudioResponseHeaders },
    );
  }
  if (error instanceof IntegrationServiceError) {
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502;
    return NextResponse.json(
      { success: false, error: error.message, code: 'PROVIDER_ERROR' },
      { status, headers: mobileStudioResponseHeaders },
    );
  }
  return jsonServerError(context, error, 'Studio request failed.');
}
