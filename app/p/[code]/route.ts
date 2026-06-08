import { NextRequest, NextResponse } from 'next/server';

import { publicShareFileResponse } from '@/app/lib/public-sharing/public-file-response';
import { resolvePublicShareShortCode } from '@/app/lib/public-sharing/public-file-shares';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { buildPublicRequestUrl } from '@/app/lib/utils/request-origin';

function publicPreviewPath(token: string, fileName: string): string {
  return `/public/view/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

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
  const decodedCode = decodeURIComponent(code);

  if (method === 'GET') {
    const previewCheck = await resolvePublicShareShortCode(decodedCode, { recordAccess: false });
    if (previewCheck.ok) {
      return NextResponse.redirect(buildPublicRequestUrl(
        request,
        publicPreviewPath(previewCheck.row.token, previewCheck.share.fileName)
      ));
    }

    if (!previewCheck.ok) {
      return publicShareFileResponse(request, previewCheck, method);
    }
  }

  const resolved = await resolvePublicShareShortCode(decodedCode);
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
