import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { McpAccessError } from '@/app/lib/mcp/access';
import { FILE_VERSION_CENTER_ERROR_CODES as Codes } from '@/app/lib/file-version-center/contracts/v1';
import { fileVersionCenterCaughtError, fileVersionCenterErrorResponse, readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';
import { MobileChatError } from './chat';

export const MOBILE_FILE_REVIEW_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export class MobileFileReviewError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export function mobileFileReviewErrorResponse(error: unknown): NextResponse {
  if (error instanceof MobileFileReviewError || error instanceof MobileChatError || error instanceof McpAccessError) {
    return NextResponse.json({ success: false, contractVersion: 1,
      code: 'code' in error ? error.code : 'REVIEW_UNAVAILABLE', error: error.message },
    { status: error.status, headers: MOBILE_FILE_REVIEW_HEADERS });
  }
  console.error('[Mobile] File review request failed:', error);
  return NextResponse.json({ success: false, contractVersion: 1, code: 'INTERNAL_ERROR', error: 'File review is unavailable.' },
    { status: 500, headers: MOBILE_FILE_REVIEW_HEADERS });
}

export function mobileFileReviewWorkspaceId(request: Request): string {
  const id = request.headers.get('x-canvas-workspace-id')?.trim();
  if (!id || id.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(id)) {
    throw new MobileFileReviewError('WORKSPACE_REQUIRED', 'An active workspace header is required.', 400);
  }
  return id;
}

export async function readMobileFileReviewJson(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new MobileFileReviewError('INVALID_REQUEST', 'A JSON request is required.', 415);
  }
  const parsed = await readBoundedJson(request, maxBytes);
  if (parsed.response) throw new MobileFileReviewError('PAYLOAD_TOO_LARGE', 'The request is too large.', 413);
  if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
    throw new MobileFileReviewError('INVALID_REQUEST', 'A valid JSON request is required.', 400);
  }
  return parsed.body as Record<string, unknown>;
}

/** The existing FVC handler retains every domain gate, rate limit and action fence. */
export async function runMobileFileVersionCenterRoute(
  request: NextRequest,
  handler: (request: NextRequest) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const workspaceId = mobileFileReviewWorkspaceId(request);
    const body = await readFileVersionCenterJson(request.clone() as NextRequest) as { target?: { workspaceId?: unknown } } | null;
    if (!body?.target || typeof body.target.workspaceId !== 'string') {
      return fileVersionCenterErrorResponse(Codes.invalidRequest, 'A versioned file target is required.', 400);
    }
    if (body.target.workspaceId !== workspaceId) {
      return fileVersionCenterErrorResponse(Codes.accessDenied, 'The file target does not belong to the active workspace.', 403);
    }
    return await handler(request);
  } catch (error) {
    if (error instanceof MobileFileReviewError) {
      return fileVersionCenterErrorResponse(Codes.invalidRequest, error.message, error.status);
    }
    return fileVersionCenterCaughtError(error);
  }
}
