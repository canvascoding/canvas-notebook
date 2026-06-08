import { NextRequest, NextResponse } from 'next/server';

import { publicShareFileResponse } from '@/app/lib/public-sharing/public-file-response';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';
import { buildPublicRequestUrl } from '@/app/lib/utils/request-origin';

function publicExcalidrawPreviewPath(token: string, fileName: string): string {
  return `/public/view/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

async function handlePublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token, filename } = await context.params;
  const decodedToken = decodeURIComponent(token);

  if (method === 'GET') {
    const previewCheck = await resolvePublicShareToken(decodedToken, { recordAccess: false });
    if (previewCheck.ok && isExcalidrawFilePath(previewCheck.workspacePath)) {
      return NextResponse.redirect(buildPublicRequestUrl(
        request,
        publicExcalidrawPreviewPath(decodedToken, previewCheck.share.fileName)
      ));
    }

    if (!previewCheck.ok) {
      return publicShareFileResponse(request, previewCheck, method, { requestedPathParts: filename });
    }
  }

  const resolved = await resolvePublicShareToken(decodedToken);
  return publicShareFileResponse(request, resolved, method, { requestedPathParts: filename });
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
