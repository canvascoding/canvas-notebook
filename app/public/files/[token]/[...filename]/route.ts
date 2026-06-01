import { NextRequest } from 'next/server';

import { publicShareFileResponse } from '@/app/lib/public-sharing/public-file-response';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';

async function handlePublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token } = await context.params;
  const resolved = await resolvePublicShareToken(decodeURIComponent(token));
  return publicShareFileResponse(request, resolved, method);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'GET');
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'HEAD');
}
