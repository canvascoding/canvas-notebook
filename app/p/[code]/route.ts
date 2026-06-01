import { NextRequest } from 'next/server';

import { publicShareFileResponse } from '@/app/lib/public-sharing/public-file-response';
import { resolvePublicShareShortCode } from '@/app/lib/public-sharing/public-file-shares';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function handleShortPublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
  method: 'GET' | 'HEAD',
) {
  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'public-short-file',
  });
  if (!limited.ok) return limited.response;

  const { code } = await context.params;
  const resolved = await resolvePublicShareShortCode(decodeURIComponent(code));
  return publicShareFileResponse(request, resolved, method);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> }
) {
  return handleShortPublicFileRequest(request, context, 'GET');
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ code: string }> }
) {
  return handleShortPublicFileRequest(request, context, 'HEAD');
}
